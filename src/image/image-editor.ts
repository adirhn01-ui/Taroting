// Image editor shell: an image project (kind "image", schema 3) opened from
// the ordinary editor route. Loaded lazily by `mountEditor` once the project
// is known to be an image project; never prefetched, so a user who never opens
// one never pays for this chunk.
//
// The shell owns the frame (top bar, stage, tool row), the session and the
// app-shell duties below; the panels and tools are mounted into it and only
// ever talk to it through the `ImageEditorCtx` it builds. It reuses the video
// editor's own shell classes and route-out ids (#ed-home, #ed-name, #ed-save,
// #ed-keep, #ed-settings, #ed-export), so the nav rescue, the Temporary badge
// and the E2E helpers apply unchanged — only one editor is ever mounted.
//
// Zero overhead at idle. The stage is repainted in ONE requestAnimationFrame, and
// only when something asked for it (a document change that touches pixels, a
// view change, a decode finishing, live ink); a paused editor schedules no
// frame, runs no timer beyond the session's autosave interval, and listens
// only for input.

import "../editor/editor.css";
import "./image-editor.css";
import { registerBeforeClose, registerCloseTask } from "../core/app-close";
import { escapeHtml, fileExt, fileStem } from "../core/format";
import { describeError, ipc, onDragDrop } from "../core/ipc";
import type { LoadedProject } from "../core/ipc";
import { exitDest, navigate } from "../core/nav";
import type { EditorRoute } from "../core/nav";
import { updateMedia } from "../core/project";
import { ProjectSession, currentSession, settingsStore } from "../core/session";
import { ShortcutManager, isTypingTarget, normalizeChord, shortcutsBlocked } from "../core/shortcuts";
import { Store } from "../core/store";
import { mediaFamilyOf } from "../core/types";
import type { ActionId, ProjectFile } from "../core/types";
import { openRelinkDialog, isStillInfo } from "../editor/media/relink";
import { icon } from "../ui/icons";
import { closeMenu } from "../ui/menu";
import { createTempExits, createTempLeaveGate } from "../ui/temp-project";
import { toast } from "../ui/toast";
import type { ImageEditorCtx } from "./context";
import { copyImage } from "./copy";
import { cancelImageCrop } from "./crop-image";
import { openImageExportDialog } from "./export-dialog";
import type { ExportSourceHint } from "./export-dialog";
import { imgIcon } from "./icons";
import { openImageMenu } from "./image-menu";
import { mountInk } from "./ink/ink";
import { mountImageInspector } from "./inspector";
import {
  addPhotoLayer,
  findLayer,
  layersOf,
  nextSelectionAfterRemove,
  removeLayer,
  validateImageProject,
} from "./layers";
import { mountLayersPanel } from "./layers-panel";
import { addRefusal, installPaste } from "./paste";
import { PreviewResources, renderComposite } from "./render";
import type { LiveInk } from "./render";
import { renderThumbnail } from "./render/export";
import type { RenderSources } from "./render/export";
import { saveBlob } from "./save";
import { mountSelectTool } from "./select-tool";
import { SIZE_MAX, SIZE_MIN, createToolStore } from "./tool-state";
import type { ToolId, ToolState } from "./tool-state";
import { mountToolbar } from "./toolbar";
import { createViewController, zoomStep } from "./view";

/** The brush-size ladder `[` and `]` step through (CSS px at the current zoom). */
export const SIZE_LADDER: readonly number[] = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 200];

/** The next ladder size above/below `size` (a size between rungs, set on the
 *  slider, goes to the nearest rung that way), clamped to the tool range. */
export function stepSize(size: number, dir: 1 | -1): number {
  let next = size;
  if (dir > 0) {
    next = SIZE_LADDER.find((s) => s > size) ?? SIZE_MAX;
  } else {
    for (let i = SIZE_LADDER.length - 1; i >= 0; i--) {
      if (SIZE_LADDER[i]! < size) {
        next = SIZE_LADDER[i]!;
        break;
      }
      next = SIZE_MIN;
    }
  }
  return Math.min(SIZE_MAX, Math.max(SIZE_MIN, next));
}

/** Which size a tool's `[` / `]` changes; the select tool has none. */
function sizeKey(tool: ToolId): keyof ToolState["sizes"] | null {
  return tool === "select" ? null : tool;
}

/** The first (bottom-most) photo's name and format: the export's default
 *  "<stem> (edited)" and its format follow the picture the project is about. */
export function exportSourceHint(p: ProjectFile): ExportSourceHint {
  const layers = layersOf(p);
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i]!;
    if (l.kind !== "photo") continue;
    const ext = fileExt(l.media.path);
    return {
      stem: fileStem(l.media.path),
      ext: ext === "png" ? "png" : ext === "jpg" || ext === "jpeg" ? "jpg" : ext === "webp" ? "webp" : null,
    };
  }
  return { stem: p.name, ext: null };
}

/** Why a drop from File Explorer is refused right now, or null to take it.
 *  In this order: a crop also holds the keyboard, and its message is the one
 *  that tells the user what to finish. A drag from Explorer presses nothing in
 *  this window, so a colour picker (never closed on blur) is still open when
 *  the drop lands — and a layer added under its preview would record that
 *  unpicked colour as the undo step before it. */
export function dropRefusal(mode: "idle" | "crop-image" | "crop-layer", modal: boolean, blocked: boolean): string | null {
  return addRefusal(mode, modal, blocked, "drop the images again");
}

/** The tool row's Canvas button: it opens the menu of whole-picture
 *  operations (image-menu.ts). Named for what it acts on, with the artboard
 *  glyph rather than the crop one, so it is never read as "edit the selected
 *  layer" — the inspector does that. */
export function canvasMenuButton(): string {
  const title = "Canvas: crop, resize, rotate or flip the whole picture";
  return `<button class="btn btn--ghost btn--sm" id="imged-menu" title="${title}" aria-haspopup="menu">${imgIcon("canvas", 14)}Canvas</button>`;
}

/** The pixel-bearing parts of a project: a change to anything else (the
 *  autosave's `modifiedAt` stamp, the name, the export preset) repaints nothing. */
interface Pixels {
  timeline: ProjectFile["timeline"];
  media: ProjectFile["media"];
  image: ProjectFile["image"];
}
const pixelsOf = (p: ProjectFile): Pixels => ({ timeline: p.timeline, media: p.media, image: p.image });
const samePixels = (a: Pixels, b: Pixels): boolean =>
  a.timeline === b.timeline && a.media === b.media && a.image === b.image;

const THUMB_CAP_MS = 1500;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The Home-card render still running for each project path, and the tail
 *  of that card's save queue. Module level, not per mount: a Keep, a leave
 *  and the next mount of the same project can all be rendering one card. */
const thumbRenders = new Map<string, AbortController>();
const thumbSaves = new Map<string, Promise<void>>();

/**
 * Render `doc`'s Home card and save it for `projectPath`, waiting for it at
 * most until `deadline` (a `Date.now()` time) — a leave or a close never waits
 * longer than that for a picture. The deadline only stops the WAITING, never
 * the render: it runs on and saves late, which is how a slow PC still gets
 * its card.
 *
 * That late write is why renders of one project are ordered. A newer render
 * aborts the one before it, whose picture is older; and the saves queue, each
 * re-checking its abort when its turn comes, so a render already saving when
 * a newer one starts finishes BEFORE the newer one writes — never after it,
 * over the newer card. A render still drawing never holds the queue up.
 * `blobFor` hands over photo files the caller already holds. Never rejects:
 * a missing thumbnail is cosmetic, Home shows the placeholder.
 */
export async function writeProjectThumb(
  doc: ProjectFile,
  projectPath: string,
  deadline: number,
  blobFor?: RenderSources["blobFor"],
): Promise<void> {
  thumbRenders.get(projectPath)?.abort();
  const ac = new AbortController();
  thumbRenders.set(projectPath, ac);
  const { signal } = ac;
  const work = (async (): Promise<void> => {
    try {
      const blob = await renderThumbnail(doc, { signal, blobFor });
      const save = (thumbSaves.get(projectPath) ?? Promise.resolve())
        .then(async () => {
          if (signal.aborted) return;
          await saveBlob({ kind: "projectThumb", projectPath, projectId: doc.id }, "jpeg", blob);
        })
        .catch(() => {});
      thumbSaves.set(projectPath, save);
      await save;
      if (thumbSaves.get(projectPath) === save) thumbSaves.delete(projectPath);
    } catch {
      // Superseded (an AbortError) or failed: either way, no card from this one.
    } finally {
      if (thumbRenders.get(projectPath) === ac) thumbRenders.delete(projectPath);
    }
  })();
  await Promise.race([work, sleep(Math.max(0, deadline - Date.now()))]);
}

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
export async function mountImageEditor(
  root: HTMLElement,
  route: EditorRoute,
  isStale: () => boolean,
  loaded: LoadedProject,
): Promise<{ dispose(): Promise<void> }> {
  const noop = { dispose: async (): Promise<void> => {} };
  if (isStale()) return noop;
  // Everything a half-built mount must undo if something below throws: the
  // shell must never be left holding a session nobody will dispose, or a
  // `currentSession` that points at a screen that is not there.
  const built: Built = { session: null, teardown: [], closeOverlays: null };
  try {
    return mount(root, route, loaded, built);
  } catch (e) {
    // Body-parked surfaces first, as dispose() does (a relink dialog opened
    // just before the throw): they hold keyboard tokens and callbacks into
    // the session about to be dropped.
    built.closeOverlays?.();
    runTeardown(built.teardown);
    // A child that parked a menu on document.body before the throw.
    closeMenu();
    const s = built.session;
    if (s) {
      if (currentSession.get() === s) currentSession.set(null);
      // Nothing was edited yet, so this writes nothing; it stops the timers.
      void s.dispose();
    }
    root.textContent = "";
    if (isStale()) return noop;
    toast.error(`Couldn't open this image project: ${describeError(e)}`);
    navigate(exitDest(route));
    return noop;
  }
}

/** What a mount has built so far, for the failure path to take apart. */
interface Built {
  session: ProjectSession | null;
  /** synchronous cleanups, run in REVERSE order (last built, first undone) */
  teardown: (() => void)[];
  /** closes every overlay registered so far; set once the registry exists */
  closeOverlays: (() => void) | null;
}

function runTeardown(list: (() => void)[]): void {
  for (let i = list.length - 1; i >= 0; i--) {
    try {
      list[i]!();
    } catch (e) {
      console.error("An image editor part failed to close", e);
    }
  }
  list.length = 0;
}

/** The synchronous body of the mount: there is no await in it, so no window
 *  in which a newer navigation could supersede it half-way. */
function mount(
  root: HTMLElement,
  route: EditorRoute,
  loaded: LoadedProject,
  built: Built,
): { dispose(): Promise<void> } {
  const undo = built.teardown;
  /* ---------------- validate, session, publish ---------------- */

  const checked = validateImageProject(loaded.project);
  const session = new ProjectSession(route.projectPath, checked.project, {
    temp: route.temp === true,
    debounceMs: 2500,
  });
  built.session = session;
  // Every exit goes through `exits`, never the bare gate: it holds them behind
  // a Keep pressed on the Temporary badge until that settles (ui/temp-project).
  const exits = createTempExits(session, createTempLeaveGate(session));
  if (session.temp.get()) session.leaveGuard = () => exits.confirm();
  currentSession.set(session);

  /* ---------------- layout ---------------- */

  const shortcutsNow = settingsStore.get().shortcuts;
  /** "Label (Chord)" from the live binding, or the bare label when unbound. */
  const titled = (label: string, action: ActionId): string => {
    const chord = normalizeChord(shortcutsNow[action] ?? "");
    return escapeHtml(chord ? `${label} (${chord})` : label);
  };
  const homeLabel = route.returnTo ? "Back to viewer" : "Back to projects";
  root.innerHTML = `
    <div class="editor imged">
      <div class="editor__topbar">
        <button class="btn btn--ghost btn--icon" id="ed-home" title="${homeLabel}" aria-label="${homeLabel}">${icon("chevronLeft")}</button>
        <div class="editor__name" id="ed-name" title="Rename project" tabindex="0">${escapeHtml(session.project.name)}</div>
        <div class="editor__savestate" id="ed-save">Saved</div>
        <div class="grow"></div>
        <button class="btn" id="imged-copy" title="${titled("Copy image", "copy")}">${imgIcon("copy")}Copy image</button>
        <button class="btn btn--ghost btn--icon" id="ed-settings" title="Settings" aria-label="Settings">${icon("gear")}</button>
        <button class="btn btn--primary" id="ed-export" title="${titled("Export", "export")}">${icon("export")}Export</button>
      </div>
      <div class="editor__body">
        <aside class="media-panel imged-layers" id="imged-layers"></aside>
        <div class="editor__main">
          <div class="editor__preview imged-stage" id="imged-stage"><canvas class="imged-canvas" id="imged-canvas"></canvas></div>
          <div class="transport imged-toolrow no-select">
            <div class="imged-tools" id="imged-tools"></div>
            <div class="imged-viewctl" id="imged-viewctl">
              <button class="btn btn--ghost btn--icon btn--sm" id="imged-undo" title="${titled("Undo", "undo")}" aria-label="Undo" disabled>${imgIcon("undo", 14)}</button>
              <button class="btn btn--ghost btn--icon btn--sm" id="imged-redo" title="${titled("Redo", "redo")}" aria-label="Redo" disabled>${imgIcon("redo", 14)}</button>
              <span class="imged-sep" aria-hidden="true"></span>
              <button class="btn btn--ghost btn--icon btn--sm" id="imged-zoom-out" title="${titled("Zoom out", "imgZoomOut")}" aria-label="Zoom out">${icon("zoomOut", 14)}</button>
              <button class="btn btn--ghost btn--sm mono imged-zoom" id="imged-zoom" title="${titled("Fit to window", "imgZoomFit")}" aria-label="Zoom level — fit to window">100%</button>
              <button class="btn btn--ghost btn--icon btn--sm" id="imged-zoom-in" title="${titled("Zoom in", "imgZoomIn")}" aria-label="Zoom in">${icon("zoomIn", 14)}</button>
              <span class="imged-sep" aria-hidden="true"></span>
              ${canvasMenuButton()}
            </div>
          </div>
        </div>
        <aside class="inspector-panel" id="imged-inspector"></aside>
      </div>
      <div class="drop-overlay" id="ed-drop">
        <div class="drop-overlay__inner">Drop images to add them as layers</div>
      </div>
    </div>
  `;
  const $ = <T extends HTMLElement>(sel: string): T => root.querySelector<T>(sel)!;
  const stage = $<HTMLElement>("#imged-stage");
  const canvas = $<HTMLCanvasElement>("#imged-canvas");
  const g = canvas.getContext("2d");
  if (!g) throw new Error("The image canvas could not be created.");

  let disposed = false;

  /* ---------------- overlays (body-parked surfaces) ---------------- */

  // Dialogs, pickers and crop modes register their closers here; dispose()
  // closes every one, so nothing parked on document.body outlives the screen
  // still pointing at this session (Home's openOverlays pattern).
  const overlays = new Set<() => void>();
  const registerOverlay = (close: () => void): (() => void) => {
    // Wrapped, so the same closer registered twice gets two entries and each
    // unregister removes only its own.
    const entry = (): void => close();
    overlays.add(entry);
    return () => {
      overlays.delete(entry);
    };
  };
  const closeOverlays = (): void => {
    for (const close of [...overlays]) {
      overlays.delete(close);
      try {
        close();
      } catch (e) {
        console.error("An image editor overlay failed to close", e);
      }
    }
  };
  built.closeOverlays = closeOverlays;

  /* ---------------- ctx ---------------- */

  const tools = createToolStore();
  const selection = new Store<string | null>(layersOf(session.project)[0]?.trackId ?? null);
  const mode = new Store<"idle" | "crop-image" | "crop-layer">("idle");
  const res = new PreviewResources(() => session.project);
  undo.push(() => res.dispose());
  // Hold to pan still works inside either crop: both hold the keyboard for
  // their whole session, but moving the view is not an edit (view.ts
  // `panThroughBlock`). A menu or picker opened during a crop lets it through
  // too, which is harmless — the pan changes nothing in the document.
  const view = createViewController(
    stage,
    canvas,
    () => ({
      w: session.project.timeline.width,
      h: session.project.timeline.height,
    }),
    { panThroughBlock: () => mode.get() !== "idle" },
  );
  undo.push(() => view.dispose());

  let live: LiveInk | null = null;
  let raf = 0;
  // The layer a per-layer crop is framing is drawn ONLY as select-tool's crop
  // ghost, never also by the composite underneath it. One Set per crop,
  // rebuilt only when the cropped layer changes — no allocation per frame.
  let skipSet: ReadonlySet<string> | undefined;
  const skipNow = (): ReadonlySet<string> | undefined => {
    const sel = mode.get() === "crop-layer" ? selection.get() : null;
    if (sel === null) return (skipSet = undefined);
    if (!skipSet?.has(sel)) skipSet = new Set([sel]);
    return skipSet;
  };
  const renderNow = (): void => {
    if (raf) {
      window.cancelAnimationFrame(raf);
      raf = 0;
    }
    if (disposed) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    try {
      renderComposite(g, session.project, res, view.store.get(), { underlay: "checker", live, skip: skipNow() });
    } catch (e) {
      // A broken frame must not take the editor with it; the next change
      // repaints. Logged, not toasted: it would repeat on every frame.
      console.error("The image could not be drawn", e);
    }
  };
  const frame = (): void => {
    raf = 0;
    renderNow();
  };
  // Coalesced: any number of requests in one frame paint once. Looked up on
  // `window` at CALL time, never captured — the E2E counts frames by wrapping
  // it, and an idle editor must be seen to ask for none.
  const requestRender = (): void => {
    if (raf || disposed) return;
    raf = window.requestAnimationFrame(frame);
  };
  // Pushed before any child or listener, so on the failure path it runs after
  // all of them (teardown is reverse order): whatever a child's teardown asked
  // for is cancelled, and nothing paints into a screen that
  // never finished mounting. (dispose() does the same itself.)
  undo.push(() => {
    disposed = true;
    if (raf) window.cancelAnimationFrame(raf);
    raf = 0;
  });

  const ctx: ImageEditorCtx = {
    session,
    tools,
    view,
    selection,
    res,
    stage,
    requestRender,
    setLive(next) {
      live = next;
      requestRender();
    },
    holdAutosave: () => session.holdAutosave(),
    mode,
    registerOverlay,
  };

  /* ---------------- subscriptions ---------------- */

  const unsubs: (() => void)[] = [];
  undo.push(() => {
    for (const u of unsubs) u();
  });

  res.setView(view.store.get(), { w: view.store.get().stageW, h: view.store.get().stageH });
  unsubs.push(
    view.store.subscribe((v, prev) => {
      res.setView(v, { w: v.stageW, h: v.stageH });
      paintZoom();
      // A new backing store is already blank (the view cleared it resizing
      // the canvas) and this runs in the same task, before the next paint:
      // repaint now rather than show one empty frame mid-resize.
      if (v.stageW !== prev.stageW || v.stageH !== prev.stageH || v.dpr !== prev.dpr) renderNow();
      else requestRender();
    }),
  );
  unsubs.push(res.onChange(requestRender));
  // Entering or leaving a layer crop hides or restores that layer in the
  // composite (skipNow); a selection change repaints only while cropping.
  unsubs.push(
    mode.subscribe((m, prev) => {
      if (m === "crop-layer" || prev === "crop-layer") requestRender();
    }),
  );
  unsubs.push(
    selection.subscribe(() => {
      if (mode.get() === "crop-layer") requestRender();
    }),
  );
  // The recorded MediaRef size wins over the decoder (amendment 5): a photo is
  // always drawn into its stored box. This fires only for a media with NO
  // recorded size (a crafted or pre-probe file), and records what the engine
  // decoded — silently, not as a user edit, so an untouched temporary photo
  // still closes without a question.
  unsubs.push(
    res.onMediaDims((mediaId, w, h) => {
      if (disposed) return;
      session.replace(updateMedia(session.project, mediaId, { width: w, height: h }), { edit: false });
    }),
  );

  let shown = pixelsOf(session.project);
  unsubs.push(
    session.store.subscribe((p) => {
      syncName();
      refreshUndo();
      const px = pixelsOf(p);
      if (samePixels(px, shown)) return;
      const resized = px.timeline.width !== shown.timeline.width || px.timeline.height !== shown.timeline.height;
      shown = px;
      // A selection whose layer is gone (removed, or undone away) is cleared,
      // so no panel or tool acts on a layer that no longer exists.
      const sel = selection.get();
      if (sel !== null && !findLayer(p, sel)) selection.set(null);
      // A crop, a rotate, a canvas resize — or the undo of one — shows the
      // whole new canvas.
      if (resized) view.fit();
      requestRender();
    }),
  );

  /* ---------------- top bar: save badge, Keep, name ---------------- */

  function paintSaveBadge(): void {
    const s = session.saveState.get();
    const badge = $("#ed-save");
    badge.classList.toggle("editor__savestate--error", s === "error");
    // A temporary session is not a kept project yet: "Temporary" (or the
    // failure) rather than Saved/Edited, exactly as the video editor says it.
    const text = session.temp.get()
      ? s === "error"
        ? "Save failed"
        : "Temporary"
      : s === "saved"
        ? "Saved"
        : s === "saving"
          ? "Saving"
          : s === "dirty"
            ? "Edited"
            : "Save failed";
    if (badge.textContent !== text) badge.textContent = text;
    paintKeep();
  }

  // Keep on the Temporary badge: make a temp project permanent without
  // leaving it. The button exists only while the session is temp; once kept
  // it goes, and so does the leave guard (nothing left to confirm).
  function paintKeep(): void {
    const existing = root.querySelector<HTMLButtonElement>("#ed-keep");
    if (!session.temp.get()) {
      existing?.remove();
      session.leaveGuard = null;
      return;
    }
    if (existing) return;
    const btn = document.createElement("button");
    btn.className = "btn btn--ghost btn--sm editor__keep";
    btn.id = "ed-keep";
    btn.title = "Keep this project in your library";
    btn.textContent = "Keep";
    btn.addEventListener("click", () => {
      btn.blur();
      void exits.keep().then((r) => {
        // The Home card needs a picture of the project it now lists.
        if (r === "kept" && !disposed) void writeThumb();
      });
    });
    $("#ed-save").after(btn);
  }
  paintSaveBadge();
  unsubs.push(session.saveState.subscribe(paintSaveBadge));
  unsubs.push(session.temp.subscribe(paintSaveBadge));

  const nameEl = $("#ed-name");
  let renaming = false;
  function syncName(): void {
    if (!renaming && nameEl.textContent !== session.project.name) nameEl.textContent = session.project.name;
  }
  function startRename(): void {
    if (renaming) return;
    renaming = true;
    const current = session.project.name;
    const input = document.createElement("input");
    input.className = "input editor__name-input";
    input.value = current;
    input.spellcheck = false;
    nameEl.textContent = "";
    nameEl.appendChild(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save: boolean): void => {
      if (done) return;
      done = true;
      renaming = false;
      if (save) {
        const value = input.value.trim();
        if (value.length > 0 && value !== current) session.commit((p) => ({ ...p, name: value }));
      }
      nameEl.textContent = session.project.name;
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        // The shell's Escape skips a typing target, so this cancels only
        // the rename, never the selection behind it.
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
  }
  nameEl.addEventListener("click", startRename);
  nameEl.addEventListener("keydown", (e) => {
    if (!renaming && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      // The key is the rename's: without this the window's own listeners
      // still hear it — view.ts would take this Space as hold to pan, with
      // the stage in pan mode while the user types the new name.
      e.stopPropagation();
      startRename();
    }
  });

  /* ---------------- tool row: undo/redo, zoom, Canvas menu ---------------- */

  const undoBtn = $<HTMLButtonElement>("#imged-undo");
  const redoBtn = $<HTMLButtonElement>("#imged-redo");
  const zoomBtn = $<HTMLButtonElement>("#imged-zoom");
  const exportBtn = $<HTMLButtonElement>("#ed-export");
  const copyBtn = $<HTMLButtonElement>("#imged-copy");
  // Written only on a flip, from the store subscription above (commit, undo,
  // redo), from `commitFrom` below and on a mode change. Greyed during a crop:
  // doUndo/doRedo refuse there, and a live-looking button that does nothing
  // reads as broken. Export and Copy image too — they refuse during a crop
  // (`refusedNow`), since they would render the crop nobody has applied.
  function refreshUndo(): void {
    const busy = mode.get() !== "idle";
    const u = busy || !session.history.canUndo;
    const r = busy || !session.history.canRedo;
    if (undoBtn.disabled !== u) undoBtn.disabled = u;
    if (redoBtn.disabled !== r) redoBtn.disabled = r;
    if (exportBtn.disabled !== busy) exportBtn.disabled = busy;
    if (copyBtn.disabled !== busy) copyBtn.disabled = busy;
  }
  // `commitFrom` (the end of a drag, a slider, a nudge) pushes the undo step
  // for changes already shown through replace() — WITHOUT a store change, so
  // no subscription hears it and Undo would stay greyed until the next edit.
  // Every caller reaches it through this session, so this instance is where
  // to hear it: the prototype method, then the buttons. Nothing to restore on
  // dispose — the session dies with the screen.
  const commitFrom = session.commitFrom.bind(session);
  session.commitFrom = (before: ProjectFile): void => {
    commitFrom(before);
    if (!disposed) refreshUndo();
  };

  function paintZoom(): void {
    const text = `${Math.round(view.store.get().zoom * 100)}%`;
    if (zoomBtn.textContent !== text) zoomBtn.textContent = text;
  }
  paintZoom();

  const stageCentre = (): { x: number; y: number } => {
    const r = stage.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  const zoomBy = (dir: 1 | -1): void => {
    const z = view.store.get().zoom;
    const target = zoomStep(z, dir);
    if (target === z) return;
    const c = stageCentre();
    view.zoomAt(target / z, c.x, c.y);
  };

  const doUndo = (): void => {
    if (mode.get() !== "idle") return;
    session.undo();
    refreshUndo();
  };
  const doRedo = (): void => {
    if (mode.get() !== "idle") return;
    session.redo();
    refreshUndo();
  };
  // Blur after a click, like the transport: a focused button would take the
  // next Space (hold to pan) as a click instead.
  const onClick = (el: HTMLElement, fn: () => void): void => {
    el.addEventListener("click", () => {
      el.blur();
      fn();
    });
  };
  onClick(undoBtn, doUndo);
  onClick(redoBtn, doRedo);
  onClick($("#imged-zoom-out"), () => zoomBy(-1));
  onClick($("#imged-zoom-in"), () => zoomBy(1));
  onClick(zoomBtn, () => view.fit());
  const menuBtn = $("#imged-menu");
  // Open FIRST, blur after: the menu records the focused element as the one to
  // return focus to, so blurring first would hand a keyboard user back to
  // <body> on Escape. The blur still frees Space for panning after a click.
  // A keyboard activation (detail 0) opens with the first row focused.
  menuBtn.addEventListener("click", (e) => {
    openImageMenu(menuBtn, ctx, e.detail === 0);
    menuBtn.blur();
  });
  refreshUndo();
  unsubs.push(mode.subscribe(refreshUndo));

  /* ---------------- exits, export, copy ---------------- */

  // Back (home, or the viewer it came from) / Ctrl+W, and the gear. A temp
  // session is resolved (kept or discarded) by the gate first — otherwise
  // dispose would flush the edits only to the doomed temp path.
  const goHome = (): void => exits.confirmLeave(() => navigate(exitDest(route)));
  const goSettings = (): void => exits.confirmLeave(() => navigate({ view: "settings" }));

  const modalOpen = (): boolean => document.querySelector(".modal-backdrop") !== null;
  // Export and Copy image render the live document, so they take the paste's
  // and the drop's own refusal. During a layer crop the live document holds a
  // crop nobody has applied (select-tool writes it through replace()), and the
  // export dialog's first write would end the crop with neither a commit nor a
  // revert; behind a dialog, a menu or a picker, a colour being previewed
  // would be rendered as though it had been picked. The chords already stay
  // inert there; the top-bar buttons are mouse paths around that, so they ask
  // here. Synchronous, so a copy still starts inside the user activation.
  const refusedNow = (retry: string): boolean => {
    const r = addRefusal(mode.get(), modalOpen(), shortcutsBlocked(), retry);
    if (r !== null) toast.info(r);
    return r !== null;
  };
  // The dialog registers its own closer with the overlay registry (and drops
  // it on every close path), so dispose() reaches it without a second entry.
  const openExport = (): void => {
    if (refusedNow("export")) return;
    openImageExportDialog(ctx, exportSourceHint(session.project));
  };
  // Synchronous inside the gesture, both from the button and from the chord:
  // the clipboard write must START inside the user activation. The photos the
  // preview already holds are handed over rather than read again from disk.
  const copyNow = (): void => {
    if (refusedNow("copy the image")) return;
    copyImage(session.project, (m) => res.blobFor(m));
  };

  $("#ed-home").addEventListener("click", goHome);
  $("#ed-settings").addEventListener("click", goSettings);
  exportBtn.addEventListener("click", openExport);
  onClick(copyBtn, copyNow);

  /* ---------------- thumbnail for Home ---------------- */

  // The pixels the Home card last showed. Null while the project is not in the
  // library yet (a temp project has no card): the first time it is kept, the
  // card gets one whatever changed.
  let thumbFor: Pixels | null = session.temp.get() ? null : pixelsOf(session.project);
  // A project that was never edited is owed a card too when it has none yet
  // (just created, or the cache was cleared): asked ONCE per mount, on leave,
  // and only when the pixel check alone says nothing is owed — an unchanged
  // project with a card costs one recents read and one stat, no render.
  let cardAsked = false;
  async function cardMissing(): Promise<boolean> {
    // Exactly the backend's match (`set_recent_thumb` compares paths as
    // given), so "owed" and "stamped" can never disagree about the entry.
    const path = session.path;
    const idx = await ipc.listRecents();
    const entry = idx.items.find((r) => r.path === path);
    // No recents entry → no card to point a picture at (the backend only
    // updates an EXISTING entry), so nothing is owed.
    if (!entry) return false;
    return !entry.thumb || !(await ipc.pathExists(entry.thumb));
  }
  async function thumbOwed(deadline: number): Promise<boolean> {
    if (session.temp.get()) return false;
    if (thumbFor === null || !samePixels(thumbFor, pixelsOf(session.project))) return true;
    if (cardAsked) return false;
    cardAsked = true;
    try {
      // Bounded like the render: a slow disk never holds a leave.
      return await Promise.race([
        cardMissing(),
        sleep(Math.max(0, deadline - Date.now())).then(() => false),
      ]);
    } catch {
      return false;
    }
  }
  // The photo files the preview holds, for a render that runs while it is
  // alive (a Keep, the window close); dispose() hands over a snapshot instead.
  const liveBlobs: RenderSources["blobFor"] = (m) => res.blobFor(m);
  // ONE budget for the check and the render together: the close task gets
  // TASK_CAP_MS in all, so a slow card check must eat into the render's time,
  // never add a second cap on top of it.
  const writeThumbIfOwed = async (blobFor = liveBlobs): Promise<void> => {
    const deadline = Date.now() + THUMB_CAP_MS;
    if (await thumbOwed(deadline)) await writeThumb(deadline, blobFor);
  };
  // Bounded and never rejecting (writeProjectThumb): a leave or a close never
  // waits longer than the deadline for a picture.
  async function writeThumb(deadline = Date.now() + THUMB_CAP_MS, blobFor = liveBlobs): Promise<void> {
    const doc = session.project;
    thumbFor = pixelsOf(doc);
    await writeProjectThumb(doc, session.path, deadline, blobFor);
  }
  // The window close never reaches dispose(): this is how Home stays current
  // after X. It runs after the close flow settled the session (a Keep in the
  // close prompt has already made it permanent; a Discard leaves it temp).
  const unregThumbTask = registerCloseTask(() => writeThumbIfOwed());
  undo.push(unregThumbTask);

  /* ---------------- children ---------------- */

  // Each child in its own teardown entry, so one that throws on close still
  // lets the others (and the session's final save) run.
  const mountChild = (c: { dispose(): void }): void => {
    undo.push(() => c.dispose());
  };
  mountChild(mountLayersPanel($("#imged-layers"), ctx));
  mountChild(mountToolbar($("#imged-tools"), ctx));
  // The inspector's Crop button enters the select tool's own on-canvas layer
  // crop. Looked up at click time: the select tool mounts just below, and the
  // mount order is the teardown order the close hooks rely on.
  const inspector = mountImageInspector($("#imged-inspector"), ctx, {
    cropLayer: (trackId) => selectTool.cropLayer(trackId),
  });
  mountChild(inspector);
  const selectTool = mountSelectTool(ctx);
  mountChild(selectTool);
  mountChild(mountInk(ctx));

  // The window close never reaches dispose() either, and its save writes the
  // live store: an unapplied layer crop or a colour being previewed would be
  // saved as though the user had chosen it. Reverted first, synchronously,
  // before the close flow reads the save state. Nothing is disposed — the user
  // can still cancel the close and carry on.
  undo.push(
    registerBeforeClose(() => {
      if (disposed) return;
      selectTool.revertCrop();
      cancelImageCrop();
      inspector.dropPreview();
    }),
  );

  /* ---------------- shortcuts ---------------- */

  const shortcuts = new ShortcutManager("image");
  shortcuts.setBindings(settingsStore.get().shortcuts);
  // Chords stay inert behind a dialog (the video editor's predicate) and
  // behind any surface holding `blockShortcuts` (the manager checks that).
  shortcuts.setSuppressed(modalOpen);
  const bind = (action: ActionId, handler: () => void): void => shortcuts.on(action, handler);
  const setTool = (tool: ToolId): void => {
    if (tools.get().tool !== tool) tools.update((s) => ({ ...s, tool }));
  };
  const nudgeSize = (dir: 1 | -1): void => {
    const key = sizeKey(tools.get().tool);
    if (!key) return;
    const cur = tools.get().sizes[key];
    const next = stepSize(cur, dir);
    if (next !== cur) tools.update((s) => ({ ...s, sizes: { ...s.sizes, [key]: next } }));
  };
  const toggleRuler = (): void => {
    const s = tools.get();
    if (s.ruler) {
      tools.update((t) => ({ ...t, ruler: null }));
      return;
    }
    // Appears level across the middle of what the user is looking at.
    const c = stageCentre();
    const at = view.clientToCanvas(c.x, c.y);
    tools.update((t) => ({ ...t, ruler: { cx: at.x, cy: at.y, angle: 0 } }));
  };
  // The selection moves to the neighbour, exactly as the layer menu's Delete
  // does (layers.ts `nextSelectionAfterRemove`), so a run of Delete presses
  // clears layers one after another. Read before the commit: after it the
  // removed layer has no place in the list to look beside. The store
  // subscriber that clears a selection whose layer is gone runs after this
  // (notifications are batched to a microtask) and finds the neighbour.
  const deleteSelected = (): void => {
    const sel = selection.get();
    if (sel === null || mode.get() !== "idle") return;
    const next = nextSelectionAfterRemove(session.project, sel);
    session.commit((p) => removeLayer(p, sel));
    selection.set(next);
  };

  bind("undo", doUndo);
  bind("redo", doRedo);
  bind("redoAlt", doRedo);
  bind("save", () => void session.save());
  bind("export", openExport);
  bind("goHome", goHome);
  bind("delete", deleteSelected);
  bind("copy", copyNow);
  bind("imgSelect", () => setTool("select"));
  bind("imgPen", () => setTool("pen"));
  bind("imgPencil", () => setTool("pencil"));
  bind("imgMarker", () => setTool("marker"));
  bind("imgEraser", () => setTool("eraser"));
  bind("imgShape", () => setTool("shape"));
  bind("imgRuler", toggleRuler);
  bind("imgSizeDown", () => nudgeSize(-1));
  bind("imgSizeUp", () => nudgeSize(1));
  bind("imgZoomIn", () => zoomBy(1));
  bind("imgZoomOut", () => zoomBy(-1));
  bind("imgZoomFit", () => view.fit());
  bind("imgZoom100", () => view.actual());
  // imgPanHold is view.ts's own keydown/keyup pair (holding needs keyup).
  shortcuts.attach();
  undo.push(() => shortcuts.detach());
  unsubs.push(
    settingsStore.subscribe((s, prev) => {
      if (s.shortcuts !== prev.shortcuts) shortcuts.setBindings(s.shortcuts);
    }),
  );

  // Escape, in order: leave a crop, else put the pen down (back to select),
  // else drop the selection. Its own capture-phase handler, so it re-applies
  // every guard the manager would. Registered after the children: a tool that
  // consumed Escape (an ink gesture cancelled, a layer crop left) marks it
  // with preventDefault and this steps aside. The whole-image crop holds the
  // keyboard and answers Escape itself.
  const onEscape = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || e.defaultPrevented || e.repeat) return;
    if (isTypingTarget(e.target) || shortcutsBlocked() || modalOpen()) return;
    const m = mode.get();
    if (m !== "idle") {
      // A layer crop that did not claim the key itself: leaving the mode is
      // its cancel (select-tool.ts restores the layer when the mode drops).
      e.preventDefault();
      mode.set("idle");
      return;
    }
    if (tools.get().tool !== "select") {
      e.preventDefault();
      setTool("select");
      return;
    }
    if (selection.get() !== null) {
      e.preventDefault();
      selection.set(null);
    }
  };
  window.addEventListener("keydown", onEscape, true);
  undo.push(() => window.removeEventListener("keydown", onEscape, true));

  /* ---------------- paste and drop ---------------- */

  undo.push(installPaste(ctx, () => disposed));

  const dropOverlay = $("#ed-drop");
  const addPhotos = async (paths: string[]): Promise<void> => {
    let project = 0;
    let other = 0;
    // One at a time, one commit each: the layers land in drop order, each
    // above the last, and one undo takes back one photo.
    for (const path of paths) {
      const ext = fileExt(path);
      if (ext === "trt") {
        project++;
        continue;
      }
      if (mediaFamilyOf(ext) !== "image") {
        other++;
        continue;
      }
      try {
        const info = await ipc.probeMedia(path);
        if (disposed) return;
        // The drop's own refusal again, for whatever opened while the probe
        // ran: a crop (a commit now would land inside it — select-tool keeps
        // the unapplied crop, with no step of its own), a dialog, or a menu or
        // picker (under a colour preview, the layer would record that colour
        // as its undo step).
        const refused = dropRefusal(mode.get(), modalOpen(), shortcutsBlocked());
        if (refused !== null) {
          toast.info(refused);
          return;
        }
        if (!isStillInfo(info)) {
          other++;
          continue;
        }
        let added: string | null = null;
        session.commit((p) => {
          const r = addPhotoLayer(p, info, { above: selection.get() });
          added = r.trackId;
          return r.project;
        });
        if (added !== null) selection.set(added);
      } catch (e) {
        if (disposed) return;
        toast.error(`Couldn't add ${fileStem(path)}: ${describeError(e)}`);
      }
    }
    if (disposed) return;
    if (project > 0) toast.info("Open projects from the home screen.");
    if (other > 0) toast.refuse("Only images can be added to an image project.");
  };
  // The unlisten can arrive after dispose(): claim it then, or the listener
  // outlives the screen and a later drop commits into a disposed session.
  let unlistenDrop: (() => void) | null = null;
  void onDragDrop({
    onHover: () => dropOverlay.classList.add("active"),
    onCancel: () => dropOverlay.classList.remove("active"),
    onDrop: (paths) => {
      dropOverlay.classList.remove("active");
      // Refused, but said out loud: a drop that silently does nothing reads
      // as broken.
      const refused = dropRefusal(mode.get(), modalOpen(), shortcutsBlocked());
      if (refused !== null) {
        toast.info(refused);
        return;
      }
      void addPhotos(paths);
    },
  })
    .then((u) => {
      if (disposed) u();
      else unlistenDrop = u;
    })
    .catch(() => {
      // No drop support: the Add layer menu still adds photos.
    });
  // The failure path too: if anything below throws, the mount unwinds without
  // dispose(), and the pending `.then` above must see `disposed` and unlisten
  // rather than park a listener that commits into a dead session.
  undo.push(() => {
    disposed = true;
    unlistenDrop?.();
    unlistenDrop = null;
  });

  /* ---------------- relink, recovered, damaged data ---------------- */

  if (loaded.recovered) toast.info("Project restored from its automatic backup.");
  if (checked.droppedStrokes > 0 || checked.notes.length > 0) {
    toast.info("Some damaged drawing data in this project was skipped.");
  }
  if (loaded.missing.length > 0) {
    // Parked on document.body: registered so dispose closes it, or it would
    // outlive this editor and relink into a project nobody saves.
    registerOverlay(openRelinkDialog({
      session,
      // A relinked photo is a new file behind the same layer: drop its cached
      // pixels and repaint.
      media: {
        retrack: (mediaId: string) => {
          const layer = layersOf(session.project).find((l) => l.mediaId === mediaId);
          res.invalidate(layer?.trackId);
          requestRender();
        },
      },
      missing: loaded.missing,
      stillsOnly: true,
    }));
  }

  /* ---------------- dev hook ---------------- */

  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__tarotingImageDev = {
      session,
      tools,
      view,
      selection,
      res,
      canvas,
      mode,
      ctx,
      renderNow,
      layers: () => layersOf(session.project),
    };
    undo.push(() => {
      delete (window as unknown as Record<string, unknown>).__tarotingImageDev;
    });
  }

  renderNow();

  return {
    async dispose() {
      if (disposed) return;
      disposed = true;
      // Body-parked surfaces first (dialogs, the colour picker, a crop): they
      // hold keyboard tokens and callbacks into this session.
      closeOverlays();
      closeMenu();
      unlistenDrop?.();
      unlistenDrop = null;
      // The card render below runs after the teardown has freed the preview's
      // photo files (a disposed PhotoCache hands over nothing): snapshot the
      // ones it holds now, so the render does not read them all from disk.
      const blobs = new Map<string, Blob | null>();
      for (const l of layersOf(session.project)) {
        if (l.kind === "photo") blobs.set(l.media.id, res.blobFor(l.media));
      }
      // Reverse build order: the dev hook, paste, Escape and the shortcuts,
      // then the children (ink, select, inspector, toolbar, layers), the close
      // task, the gesture hooks, the subscriptions, the view and the pixels.
      runTeardown(undo);
      if (raf) window.cancelAnimationFrame(raf);
      raf = 0;
      await writeThumbIfOwed((m) => blobs.get(m.id) ?? null);
      if (currentSession.get() === session) currentSession.set(null);
      await session.dispose();
    },
  };
}
