// Editor shell: session (autosave/undo), media manager, preview stage,
// playback engine, canvas timeline, transport bar, and keyboard shortcuts.

import "./editor.css";
import "../ui/player-bar.css";
import { escapeHtml, fileExt, fileName, fileStem, formatTimecode } from "../core/format";
import { describeError, ipc, mediaUrl, onDragDrop, pickMediaFiles } from "../core/ipc";
import type { LoadedProject } from "../core/ipc";
import { mediaDisplayName } from "../core/media-name";
import { exitDest, navigate } from "../core/nav";
import type { EditorRoute } from "../core/nav";
import { createMonitorVolume } from "../core/monitor-volume";
import type { MonitorVolumeState } from "../core/monitor-volume";
import {
  addAudioTrack,
  addMarkerAt,
  addMedia,
  addVideoTrack,
  findClip,
  findMedia,
  findTrack,
  insertClip,
  MIN_CLIP_DUR,
  makeClip,
  removeClip,
  removeMediaCascade,
  removeTrack,
  rippleDelete,
  splitClip,
  topVideoTrack,
  uid,
  updateClip,
  videoTracks,
} from "../core/project";
import { registerCloseTask } from "../core/app-close";
import { ProjectSession, currentSession, settingsStore, updateSettings } from "../core/session";
import { ShortcutManager } from "../core/shortcuts";
import { Store } from "../core/store";
import { clipEnd, frameOf, locate } from "../core/time";
import { MEDIA_FILE_EXTENSIONS, TIMELINE_HEIGHT_MAX } from "../core/types";
import type {
  ActionId,
  AnimProp,
  Clip,
  ClipKeyframes,
  MediaInfo,
  MediaRef,
  ProjectFile,
  Rational,
  Timeline,
  Track,
} from "../core/types";
import { icon } from "../ui/icons";
import { closeMenu, showMenu } from "../ui/menu";
import { toast } from "../ui/toast";
import { openExportDialog } from "./export/export-dialog";
import { mountInspector } from "./inspector/inspector";
import { openGeneratorDialog } from "./media/generators";
import { MediaManager } from "./media/media";
import { openRelinkDialog } from "./media/relink";
import { statusChange } from "./media/status-diff";
import { AudioGraph } from "./playback/audio-graph";
import { PlaybackEngine } from "./playback/engine";
import { Scheduler } from "./playback/scheduler";
import { mountStage } from "./preview/preview";
import { clampCrop } from "./preview/canvas-math";
import { mountCanvasOverlay } from "./preview/overlay";
import type { CanvasOverlay } from "./preview/overlay";
import { mountTheater } from "./preview/theater";
import { collectCandidates, snapTime } from "./timeline/snap";
import { laneLabels, laneLayout } from "./timeline/render";
import { createLaneAutoScroll, type LaneAutoScroller } from "./timeline/interactions";
import { focusFirst, trapTab } from "../ui/focus";
import { createTempExits, createTempLeaveGate } from "../ui/temp-project";
import type { TempExits } from "../ui/temp-project";
import { PREVIEW_MIN_H, clampPanelHeight, maxPanelHeight } from "./timeline/panel-size";
import { TimelineController } from "./timeline/timeline";

/** Where every exit from this editor lands. Defined in core/nav so the image
 *  editor (a separate chunk) shares the one rule; re-exported for the callers
 *  and tests that know it from here. */
export { exitDest };

/**
 * Why a file of `kind` can't replace the media of a clip on a `lane` layer, or
 * null when it can. The rule every other placement path already applies (the
 * bin drop's kindOk, placeAtPlayhead's isVisualMedia routing): sound goes on
 * audio layers, pictures and video on video layers. A song on a video layer
 * would preview as an empty frame and fail the export on its missing video
 * stream; a picture on an audio layer would play silent.
 */
export function replaceMediaRefusal(lane: Track["kind"], kind: MediaInfo["kind"]): string | null {
  if ((kind === "audio") === (lane === "audio")) return null;
  return lane === "audio" ? "Choose a sound file for an audio layer." : "Choose a video or picture for a video layer.";
}

/**
 * Confirm for deleting a non-empty layer. Reuses the app modal pattern +
 * trapTab (as in home.ts / generators.ts). Returns its closer so the editor's
 * dispose() takes it down with the screen that opened it.
 *
 * The action is undoable (Ctrl+Z), so the button is the primary one, not
 * danger-red. Focus opens on Cancel and Enter activates whichever button has
 * focus — there is no document-wide Enter-means-delete.
 */
export function confirmDeleteLayer(label: string, n: number, onConfirm: () => void): () => void {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="Delete layer ${escapeHtml(label)}">
        <div class="modal__header">Delete layer ${escapeHtml(label)}</div>
        <div class="modal__body">
          <div class="modal__text">Delete layer ${escapeHtml(label)} and its ${n === 1 ? "clip" : `${n} clips`}? This can be undone with Ctrl+Z.</div>
        </div>
        <div class="modal__footer">
          <button class="btn" data-act="cancel">Cancel</button>
          <button class="btn btn--primary" data-act="confirm">Delete</button>
        </div>
      </div>`;
  document.body.appendChild(backdrop);

  const releaseTrap = trapTab(backdrop);
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    releaseTrap();
    document.removeEventListener("keydown", onKey, true);
    backdrop.remove();
  };
  const confirm = (): void => {
    close();
    onConfirm();
  };
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }
  document.addEventListener("keydown", onKey, true);
  backdrop.addEventListener("pointerdown", (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector('[data-act="cancel"]')!.addEventListener("click", close);
  backdrop.querySelector('[data-act="confirm"]')!.addEventListener("click", confirm);
  focusFirst(backdrop, '[data-act="cancel"]');
  return close;
}

/**
 * Mount the editor for `route` into `root`.
 *
 * `isStale` is the caller's navigation-token check. A mount is SUPERSEDED when
 * another navigation starts while it is still awaiting (an OS open from File
 * Explorer landing mid-load is the real case), and go() only re-checks its
 * token AFTER this function returns — by which point the old code had already
 * painted over the newer screen and put its session in `currentSession`, where
 * the newer screen's own session belonged. So this checks after every await
 * that precedes a visible or shared effect, and a stale mount returns a no-op
 * handle having touched nothing: no toast, no navigation, no DOM, no
 * currentSession, no media work started.
 */
export async function mountEditor(
  root: HTMLElement,
  route: EditorRoute,
  isStale: () => boolean,
): Promise<{ dispose(): Promise<void> }> {
  const noop = { dispose: async (): Promise<void> => {} };

  let loaded;
  try {
    loaded = await ipc.loadProject(route.projectPath);
  } catch (e) {
    // A superseded mount whose load failed must neither toast nor navigate
    // over the newer screen: the user has already moved on.
    if (isStale()) return noop;
    toast.error(describeError(e));
    // A viewer-launched editor that cannot load goes back to the viewer on the
    // same file, not home: the user came from there and never asked to leave.
    navigate(exitDest(route));
    return noop;
  }
  if (isStale()) return noop;

  // An IMAGE project gets its own editor, from its own lazy chunk that nothing
  // prefetches. The route carries no kind, so this is the first moment it is
  // known — and nothing of the video editor has been built yet: no session, no
  // media manager, no AudioContext. The video path pays one property read.
  // The image editor takes the same `isStale` and the whole route (temp,
  // returnTo), because it owes the app shell everything this function does:
  // currentSession, the temp leave gate, the close tasks, returnTo exits.
  if (loaded.project.kind === "image") {
    let mountImageEditor: typeof import("../image/image-editor").mountImageEditor;
    try {
      ({ mountImageEditor } = await import("../image/image-editor"));
    } catch (e) {
      // A chunk that failed to load is a failed open, handled like a failed
      // load above: without this the rejection escapes go() unhandled and
      // leaves #app blank, with no way out but the window close.
      if (isStale()) return noop;
      toast.error(describeError(e));
      navigate(exitDest(route));
      return noop;
    }
    // The chunk load is an await: a navigation that superseded this mount
    // meanwhile owns the screen, so step aside having touched nothing.
    if (isStale()) return noop;
    return mountImageEditor(root, route, isStale, loaded);
  }

  const session = new ProjectSession(route.projectPath, loaded.project, {
    temp: route.temp === true,
  });
  // A temporary session is a throwaway file that startup cleanup deletes, so
  // ANY route away from it must offer keep-or-discard first. Back/Ctrl+W/gear
  // go through the gate directly; this guard covers the paths that do not —
  // an OS "open with" request arriving from File Explorer (which used to
  // navigate straight past the prompt and silently destroy the work) and the
  // window close. Every exit goes through `exits`, never the bare gate: it
  // holds them behind a Keep pressed on the Temporary badge (see paintKeep)
  // until that settles, so no exit can prompt — and Keep a second time —
  // mid-relocate. paintKeep clears the guard once the project is kept.
  const exits = createTempExits(session, createTempLeaveGate(session));
  if (session.temp.get()) session.leaveGuard = () => exits.confirm();
  const media = new MediaManager(() => session.project);
  await media.init();
  // The second await. Nothing shared has been touched yet, so a superseded
  // mount unwinds privately: the session has no edits (dispose writes nothing,
  // it only stops the autosave timers) and ensureAll below has not started any
  // plan/waveform/thumbnail work for a screen nobody will see.
  if (isStale()) {
    media.dispose();
    void session.dispose();
    return noop;
  }
  currentSession.set(session);

  // From here on the session is PUBLISHED: it autosaves, and its leave guard
  // intercepts every OS open. If building the screen throws — a mount that
  // renders a corrupt project is the real shape: the inspector's first render
  // and the first-frame seek both read every keyframe — nothing would ever
  // dispose it, and the window would be stuck behind a dead editor's guard,
  // shortcuts and close task. So a throw runs the same teardown dispose()
  // does, over whatever had been built when it happened, and is then rethrown
  // for the navigator to report.
  const teardown = new Teardown();
  try {
    return buildEditor(root, route, loaded, session, media, exits, teardown);
  } catch (e) {
    teardown.run();
    media.dispose();
    if (currentSession.get() === session) currentSession.set(null);
    void session.dispose();
    throw e;
  }
}

/**
 * Everything a mounted editor must undo when it goes, registered as each piece
 * is built and run last-in-first-out. ONE list serves both ways out — the
 * handle's dispose() and a mount that threw halfway — so the failure path can
 * never forget a piece the normal path remembers. The order is the build
 * order reversed: a listener is removed before the thing it listens to is
 * disposed, and nothing is touched that was never built.
 */
class Teardown {
  private steps: (() => void)[] = [];
  private ran = false;

  /** True once run() has started: the editor is closed, so a late async
   *  answer (a file picker, a probe, a drop registration) must not touch it. */
  get done(): boolean {
    return this.ran;
  }

  add(step: () => void): void {
    this.steps.push(step);
  }

  /** Every step, newest first, each isolated: one piece that throws while
   *  coming down must not leave the rest up — least of all the session flush
   *  that follows, which is where the user's last edit lives. */
  run(): void {
    if (this.ran) return;
    this.ran = true;
    for (let i = this.steps.length - 1; i >= 0; i--) {
      try {
        this.steps[i]!();
      } catch (e) {
        console.error("Editor teardown step threw; the remaining steps still ran", e);
      }
    }
    this.steps = [];
  }
}

/** The refusal for files a closed editor never took in: an import, a drop or a
 *  Replace media whose picker or probe answered after the project was gone. It
 *  says so rather than letting the files vanish, on whatever screen is showing
 *  now. Exported for the tests. */
export function closedImportMessage(paths: string[]): string {
  return paths.length === 1
    ? `${fileName(paths[0]!)} wasn't imported because the project was closed.`
    : `${paths.length} files weren't imported because the project was closed.`;
}

/**
 * `c` pointed at a different file by Replace media, with everything that
 * derives from the old file's identity carried over. Pure — exported for the
 * tests.
 *
 * - srcIn restarts at 0 and the length is kept where the new file allows it:
 *   clamped to the new file's duration, floored at one minimum clip in SOURCE
 *   seconds (`MIN_CLIP_DUR * speed`, the floor relink applies), so a short
 *   file never makes a zero-length clip. A still keeps its footprint: it has
 *   no duration to clamp to.
 * - Keyframes are in source seconds, so moving srcIn to 0 alone would slide
 *   every one of them by the old srcIn: an animation timed to the clip's first
 *   second would play wherever the old trim started. Every key is shifted by
 *   -srcIn and none is dropped — x/y stay paired and no array goes empty (an
 *   empty array throws in evalKfs). A key that lands before 0 is an
 *   out-of-range anchor, which keyframes already allow.
 * - The crop is in source pixels of the OLD file. A smaller replacement would
 *   leave it hanging outside the frame, so it is clamped into the new one
 *   exactly as relink clamps it.
 */
export function retargetClip(c: Clip, mediaId: string, info: MediaInfo): Clip {
  const len = c.srcOut - c.srcIn;
  const srcOut =
    info.kind === "image" ? len : Math.max(MIN_CLIP_DUR * c.speed, Math.min(info.duration, len));
  const next: Clip = { ...c, mediaId, srcIn: 0, srcOut };
  if (c.keyframes && c.srcIn !== 0) {
    const shifted: ClipKeyframes = {};
    for (const prop of Object.keys(c.keyframes) as AnimProp[]) {
      const kfs = c.keyframes[prop];
      if (kfs) shifted[prop] = kfs.map((k) => ({ t: k.t - c.srcIn, v: k.v }));
    }
    next.keyframes = shifted;
  }
  const crop = c.transform?.crop;
  if (crop && c.transform && info.width && info.height) {
    next.transform = { ...c.transform, crop: clampCrop(crop, info.width, info.height) };
  }
  return next;
}

/**
 * The video editor's screen, built against a session that is already
 * published. Split from mountEditor only so that a throw anywhere in here
 * reaches mountEditor's catch (see there); every piece that needs undoing
 * registers with `teardown` as it is built.
 */
function buildEditor(
  root: HTMLElement,
  route: EditorRoute,
  loaded: LoadedProject,
  session: ProjectSession,
  media: MediaManager,
  exits: TempExits,
  teardown: Teardown,
): { dispose(): Promise<void> } {
  /** The editor has closed (or never finished opening): a late answer to
   *  anything it awaited must leave the session and the screen alone. */
  const disposed = (): boolean => teardown.done;

  // The ids the load reported missing or changed go in with this first call
  // only: the manager checks each one exists before asking for a thumbnail,
  // waveform or playback plan, so a file that is not there shows as failed
  // instead of Ready over a black stage, and a crafted path from the .trt
  // reaches no ffmpeg work before the relink dialog below has been answered.
  media.ensureAll(session.project, loaded.missing);

  if (loaded.recovered) toast.info("Project restored from its automatic backup.");

  /* ---------------- layout ---------------- */

  const homeLabel = route.returnTo ? "Back to viewer" : "Back to projects";
  root.innerHTML = `
    <div class="editor">
      <div class="editor__topbar">
        <button class="btn btn--ghost btn--icon" id="ed-home" title="${homeLabel}" aria-label="${homeLabel}">${icon("chevronLeft")}</button>
        <div class="editor__name" id="ed-name" title="Rename project" tabindex="0">${escapeHtml(session.project.name)}</div>
        <div class="editor__savestate" id="ed-save">Saved</div>
        <div class="grow"></div>
        <button class="btn" id="ed-import">${icon("plus")}Import media</button>
        <button class="btn btn--ghost btn--icon" id="ed-settings" title="Settings">${icon("gear")}</button>
        <button class="btn btn--primary" id="ed-export" title="Export (Ctrl+E)">${icon("export")}Export</button>
      </div>
      <div class="editor__body">
        <aside class="media-panel">
          <div class="media-panel__header no-select">Media</div>
          <div class="media-panel__add no-select">
            <button class="btn btn--sm" id="ed-add-text" title="Add a text element"><span class="gen-glyph">T</span>Text</button>
            <button class="btn btn--sm" id="ed-add-solid" title="Add a solid color element"><span class="gen-glyph">■</span>Solid</button>
          </div>
          <div class="media-list" id="media-list"></div>
        </aside>
        <div class="editor__main">
          <div class="editor__preview" id="ed-stage"></div>
          <div class="timeline-panel">
            <div class="timeline-resize" id="ed-tl-resize" role="separator" aria-orientation="horizontal" title="Resize timeline"></div>
            <div class="transport no-select">
              <button class="btn btn--ghost btn--icon btn--sm" id="tr-step-back" title="Previous frame (←)">${icon("stepBack", 14)}</button>
              <button class="btn btn--icon" id="tr-play" title="Play/Pause (Space)">${icon("play")}</button>
              <button class="btn btn--ghost btn--icon btn--sm" id="tr-step-fwd" title="Next frame (→)">${icon("stepFwd", 14)}</button>
              <button class="btn btn--ghost btn--icon btn--sm" id="tr-stop" title="Stop">${icon("stop", 14)}</button>
              <button class="btn btn--ghost btn--icon btn--sm" id="tr-fullscreen" title="Fullscreen (F)">${icon("fullscreen", 14)}</button>
              <div class="transport__time mono" id="tr-time">00:00:00</div>
              <div class="grow"></div>
              <select class="select select--sm" id="tr-speed" title="Playback speed">
                <option value="0.25">0.25×</option>
                <option value="0.5">0.5×</option>
                <option value="1" selected>1×</option>
                <option value="1.5">1.5×</option>
                <option value="2">2×</option>
              </select>
              <div class="tr-volume" id="tr-volume">
                <button class="btn btn--ghost btn--icon btn--sm" id="tr-volume-btn" title="Monitor volume" aria-haspopup="true" aria-expanded="false">${icon("volume", 14)}</button>
                <div class="tr-volume__flyout" id="tr-volume-flyout" hidden>
                  <input class="slider tr-volume__slider" id="tr-volume-slider" type="range" min="0" max="1" step="0.01" aria-label="Monitor volume" />
                </div>
              </div>
              <button class="btn btn--ghost btn--icon btn--sm" id="tr-loop" title="Loop playback (L)">${icon("loop", 14)}</button>
              <button class="btn btn--ghost btn--icon btn--sm btn--on" id="tr-snap" title="Snapping (N)">${icon("magnet", 14)}</button>
              <button class="btn btn--ghost btn--icon btn--sm" id="tr-split" title="Split at playhead (S)">${icon("scissors", 14)}</button>
              <button class="btn btn--ghost btn--icon btn--sm" id="tr-marker" title="Add marker (M)">${icon("flag", 14)}</button>
              <button class="btn btn--ghost btn--icon btn--sm" id="tr-add-layer" title="Add video layer">${icon("plus", 14)}</button>
              <button class="btn btn--ghost btn--icon btn--sm" id="tr-zoom-out" title="Zoom out">${icon("zoomOut", 14)}</button>
              <button class="btn btn--ghost btn--icon btn--sm" id="tr-zoom-in" title="Zoom in (Ctrl+wheel)">${icon("zoomIn", 14)}</button>
            </div>
            <div class="timeline-host" id="ed-timeline"></div>
          </div>
        </div>
        <aside class="inspector-panel" id="ed-inspector"></aside>
      </div>
      <div class="drop-overlay" id="ed-drop">
        <div class="drop-overlay__inner">Drop to import into this project</div>
      </div>
    </div>
  `;

  const $ = <T extends HTMLElement>(sel: string): T => root.querySelector<T>(sel)!;

  /* ---------------- playback stack ---------------- */

  // mountStage invokes the resize callback synchronously during construction,
  // before the engine exists — route it through a mutable ref. The stage reads
  // the CURRENT timeline dims via the getter so a later resolution adoption
  // refits (Addendum #9).
  let engineRef: PlaybackEngine | null = null;
  const stage = mountStage(
    $("#ed-stage"),
    () => ({ width: session.project.timeline.width, height: session.project.timeline.height }),
    () => engineRef?.refresh(),
  );
  teardown.add(() => stage.dispose());
  const scheduler = new Scheduler(stage, () => session.project, media);
  const engine = new PlaybackEngine(() => session.project, scheduler);
  engineRef = engine;

  const graph = new AudioGraph(() => session.project, media, scheduler);
  // Registered graph-then-engine so they come down engine-then-graph: the
  // engine (which disposes the scheduler) stops before the audio context closes.
  teardown.add(() => graph.dispose());
  teardown.add(() => engine.dispose());
  teardown.add(engine.onTick((t, playing) => graph.tick(t, playing, engine.previewSpeed)));

  /* ---------------- monitor (preview listening) volume ---------------- */

  // Single source of truth for the preview LISTENING level, shared by the
  // transport flyout and the theater bar. It scales the audio graph's master
  // bus only — never per-clip audio, the project, or exports. Seeded from the
  // persisted Settings.monitorVolume; every change applies to the graph, is
  // persisted (debounced) via updateSettings, and notifies both UIs so they
  // stay in sync. The controller lives in core so the viewer can share it.
  const volume = createMonitorVolume(
    (level) => graph.setMonitorVolume(level),
    (e) =>
      toast.error("Couldn't save your settings.", {
        detail: describeError(e),
        op: "Settings",
        title: "Monitor volume",
      }),
  );
  teardown.add(() => volume.dispose());
  // The level is written 300 ms after the last change. Closing the window
  // inside that window would drop it; dispose() is not reached on a close, so
  // the close flow runs this instead. Registered after the dispose above so it
  // is unregistered BEFORE it: a close request landing after this screen is
  // gone must not flush a disposed controller.
  teardown.add(registerCloseTask(() => volume.flush()));

  // Refit the stage when the project canvas w/h changes (resolution adoption,
  // canvas settings). Cheap: compares two numbers per project change.
  let stageW = session.project.timeline.width;
  let stageH = session.project.timeline.height;
  teardown.add(
    session.store.subscribe(() => {
      const { width, height } = session.project.timeline;
      if (width !== stageW || height !== stageH) {
        stageW = width;
        stageH = height;
        stage.refit();
      }
    }),
  );

  /* ---------------- ui state ---------------- */

  const selection = new Store<string | null>(null);
  let snapOn = true;
  let clipboard: { clip: Clip; kind: "video" | "audio" } | null = null;

  const select = (id: string | null): void => {
    selection.set(id);
  };
  const selectedClipId = (): string | null => selection.get();

  const timeline = new TimelineController($("#ed-timeline"), {
    session,
    media,
    engine,
    select,
    getSelected: () => selection.get(),
    snapEnabled: () => snapOn,
    onClipMenu: (clip, clientX, clientY) => openClipMenu(clip, clientX, clientY),
    onLaneMenu: (track, clientX, clientY) => openLaneMenu(track, clientX, clientY),
  });
  teardown.add(() => timeline.dispose());

  // The inspector is mounted before the overlay, but reads the overlay's
  // gesture state: a canvas drag replace()s the project once per pointermove,
  // and the inspector skips its rebuilds while one is live, rebuilding once
  // when it ends (onGestureEnd below). Same mutable-ref idiom as engineRef;
  // false until the overlay exists, which is also the truth.
  let overlayRef: CanvasOverlay | null = null;
  const inspector = mountInspector($("#ed-inspector"), {
    session,
    media,
    engine,
    selection,
    refresh: (): void => {
      engine.refresh();
      timeline.requestRender();
    },
    overlayGestureActive: (): boolean => overlayRef?.gestureActive() ?? false,
  });
  teardown.add(() => inspector.dispose());

  // Canvas direct manipulation: selection box, drag/scale, and crop mode over
  // the preview stage. Shares the same selection store and refresh path.
  const overlay = mountCanvasOverlay({
    stage,
    scheduler,
    engine,
    session,
    selection,
    refresh: () => {
      engine.refresh();
      timeline.requestRender();
    },
    // The crop ghost decodes what the stage plays — the proxy or remux when
    // the manager made one — exactly as the scheduler's urlFor resolves it:
    // the original of a proxied source is the file the WebView cannot decode.
    // Null while no plan is ready; the overlay then falls back to the original.
    playbackUrl: (m) => {
      const s = media.status.get()[m.id];
      return s?.state === "ready" ? s.url : null;
    },
    // A committed drag notifies no store subscriber on its way out, so the
    // inspector that sat out the drag is told here.
    onGestureEnd: () => inspector.overlayGestureEnded(),
  });
  overlayRef = overlay;
  teardown.add(() => overlay.dispose());

  // Fullscreen playback (theater mode). Lives on the preview container so it can
  // lift the whole stage over the editor chrome; the transport button glyph flips
  // to reflect the open/close state via onChange. Entering it drops any canvas
  // drag in flight (cancelGesture), so a drag cannot go on editing the project
  // under the view-only theater canvas.
  const theater = mountTheater({
    engine,
    container: $("#ed-stage"),
    volume,
    onChange: (on: boolean): void => {
      const btn = $("#tr-fullscreen");
      btn.innerHTML = icon(on ? "fullscreenExit" : "fullscreen", 14);
      btn.title = on ? "Exit fullscreen (F)" : "Fullscreen (F)";
    },
    // refit the letterbox on every theater/fullscreen size transition so the
    // video scales crisply to the new container box (the ResizeObserver alone
    // can race the fixed inset-0 jump).
    refit: (): void => stage.refit(),
    cancelGesture: (): void => overlay.cancelGesture(),
  });
  teardown.add(() => theater.dispose());

  /* ---------------- actions ---------------- */

  const commit = (mutate: Parameters<ProjectSession["commit"]>[0]): void => {
    session.commit(mutate);
    engine.refresh();
    timeline.requestRender();
  };

  function clipUnderPlayhead(): Clip | null {
    const t = engine.time;
    const p = session.project;
    const sel = selectedClipId();
    if (sel) {
      const f = findClip(p, sel);
      if (f && t > f.clip.timelineStart + 1e-6 && t < clipEnd(f.clip) - 1e-6) return f.clip;
    }
    for (const track of p.timeline.tracks) {
      const loc = locate(track, t);
      if (loc.kind === "clip") return loc.clip;
    }
    return null;
  }

  const actions = {
    split(): void {
      const target = clipUnderPlayhead();
      if (!target) return;
      const t = engine.time;
      commit((p) => splitClip(p, target.id, t).project);
    },
    remove(): void {
      const id = selectedClipId();
      if (!id) return;
      select(null);
      commit((p) => removeClip(p, id));
    },
    ripple(): void {
      const id = selectedClipId();
      if (!id) return;
      select(null);
      commit((p) => rippleDelete(p, id));
    },
    copy(): void {
      const id = selectedClipId();
      if (!id) return;
      const found = findClip(session.project, id);
      if (found) {
        clipboard = {
          clip: JSON.parse(JSON.stringify(found.clip)) as Clip,
          kind: found.track.kind,
        };
      }
    },
    paste(): void {
      if (!clipboard) return;
      // The clipboard outlives its media: removeMediaCascade drops the media and
      // every clip that references it, but knows nothing about this module-local
      // deep clone. Pasting it would insert a clip whose mediaId resolves to
      // nothing — checkInvariants reports "unknown media", it renders as a
      // nameless gap with no inspector, and the dangling reference reaches the
      // exporter. Bail instead.
      if (!findMedia(session.project, clipboard.clip.mediaId)) return;
      const at = engine.time;
      const { clip, kind } = clipboard;
      // The pasted clip becomes the selection, as a placed one does: left on
      // the original, the next Delete removed the clip that was copied rather
      // than the one just pasted (which insertClip may also have moved out of
      // view).
      const newId = uid();
      commit((p) => {
        let proj = p;
        let trackId: string;
        if (kind === "video") {
          trackId = proj.timeline.tracks[0]!.id;
        } else {
          const audio = proj.timeline.tracks.find((t) => t.kind === "audio");
          if (audio) trackId = audio.id;
          else {
            const r = addAudioTrack(proj);
            proj = r.project;
            trackId = r.trackId;
          }
        }
        const pasted: Clip = { ...clip, id: newId, timelineStart: at };
        return insertClip(proj, trackId, pasted);
      });
      if (findClip(session.project, newId)) select(newId);
    },
    undo(): void {
      session.undo();
      // clear selection if it no longer resolves after the history step
      const sel = selectedClipId();
      if (sel && !findClip(session.project, sel)) select(null);
      engine.refresh();
      timeline.requestRender();
    },
    redo(): void {
      session.redo();
      // clear selection if it no longer resolves after the history step
      const sel = selectedClipId();
      if (sel && !findClip(session.project, sel)) select(null);
      engine.refresh();
      timeline.requestRender();
    },
  };

  /* ---------------- clip context menu ---------------- */

  // Pick one media file and retarget `clip` at it: probe → add to the bin →
  // point the clip's mediaId at it (retargetClip: srcIn restarts at 0, the
  // length, keyframes and crop follow). No confirmation.
  //
  // Both awaits can outlast the editor — an Explorer open replaces it while
  // the picker is up — and a closed editor's session must not take the file:
  // the user is told instead (the same rule as importPaths).
  async function replaceClipMedia(clip: Clip): Promise<void> {
    const files = await pickMediaFiles();
    const path = files[0];
    if (!path) return;
    if (disposed()) {
      toast.refuse(closedImportMessage([path]));
      return;
    }
    let info: MediaInfo;
    try {
      info = await ipc.probeMedia(path);
    } catch (e) {
      if (disposed()) toast.refuse(closedImportMessage([path]));
      else toast.error(`Couldn't read ${fileStem(path)}: ${describeError(e)}`);
      return;
    }
    if (disposed()) {
      toast.refuse(closedImportMessage([path]));
      return;
    }
    // Gone by the time the file was read: there is nothing to retarget, and
    // adding the file anyway would leave an orphan in the bin.
    const lane = findClip(session.project, clip.id)?.track.kind;
    if (!lane) return;
    const refusal = replaceMediaRefusal(lane, info.kind);
    if (refusal) {
      toast.refuse(refusal);
      return;
    }
    // A probe that reports no length for a timed file has nothing to clamp the
    // clip to; taking it would make a clip that plays nothing. A still's 0 is
    // the absence of a duration, not a zero-length file (relink's rule).
    if (info.kind !== "image" && !(info.duration > 0)) {
      toast.refuse(`${fileName(path)} has no length, so it can't replace this clip.`);
      return;
    }
    commit((p) => {
      const added = addMedia(p, info);
      return updateClip(added.project, clip.id, (c) => retargetClip(c, added.media.id, info));
    });
    media.ensureAll(session.project);
    select(clip.id);
  }

  // Built on demand by the timeline (right-click on a clip). The clip is already
  // selected by the timeline before this runs. Instant actions, no confirms.
  function openClipMenu(clip: Clip, clientX: number, clientY: number): void {
    const t = engine.time;
    const insideClip = t > clip.timelineStart + 1e-6 && t < clipEnd(clip) - 1e-6;
    showMenu(clientX, clientY, [
      { label: "Copy", onSelect: () => actions.copy() },
      { label: "Split at playhead", disabled: !insideClip, onSelect: () => actions.split() },
      {
        label: "Replace media",
        onSelect: () =>
          void replaceClipMedia(clip).catch((e: unknown) => {
            if (!disposed()) toast.error(describeError(e));
          }),
      },
      { label: "Delete", onSelect: () => actions.remove() },
      { label: "Ripple delete", danger: true, onSelect: () => actions.ripple() },
    ]);
  }

  // The lane's NLE label (e.g. "V2"), matching render.ts laneLabels naming.
  function laneLabelOf(track: Track): string {
    const p = session.project;
    const i = p.timeline.tracks.findIndex((t) => t.id === track.id);
    return laneLabels(p)[i] ?? track.name;
  }

  // Remove a track and keep selection/overlay consistent: if the deleted track
  // held the selected clip, clear the selection first (same idiom as undo/redo).
  function deleteLayer(trackId: string, force: boolean): void {
    const sel = selectedClipId();
    if (sel && findClip(session.project, sel)?.track.id === trackId) select(null);
    commit((p) => removeTrack(p, trackId, force ? { force: true } : undefined));
  }

  // Right-click on a lane (no clip hit). One item "Delete layer VN" — disabled
  // for the sole video layer; empty layers delete instantly, non-empty ones ask
  // to confirm first (undoable either way). The confirm lives on document.body,
  // so dispose() closes it with the editor.
  let closeDeleteLayer: () => void = () => {};
  teardown.add(() => closeDeleteLayer());
  function openLaneMenu(track: Track, clientX: number, clientY: number): void {
    const label = laneLabelOf(track);
    const isSoleVideo = track.kind === "video" && videoTracks(session.project).length < 2;
    showMenu(clientX, clientY, [
      {
        label: `Delete layer ${label}`,
        danger: true,
        disabled: isSoleVideo,
        title: isSoleVideo ? "The last video layer can't be deleted" : undefined,
        onSelect: () => {
          const t = findTrack(session.project, track.id);
          if (!t) return;
          const n = t.clips.length;
          if (n === 0) {
            deleteLayer(track.id, false);
          } else {
            closeDeleteLayer = confirmDeleteLayer(label, n, () => deleteLayer(track.id, true));
          }
        },
      },
    ]);
  }

  /* ---------------- transport ---------------- */

  const playBtn = $("#tr-play");
  const timeEl = $("#tr-time");
  const loopBtn = $("#tr-loop");
  const snapBtn = $("#tr-snap");

  // Idempotent: the tick listener runs this ~60×/s during playback. Rewriting
  // innerHTML every tick would destroy and recreate the inner <svg> under the
  // cursor mid-press, so a real mouse-down that landed on the old glyph never
  // pairs with its mouse-up → the browser eats the click and pause is missed
  // ("hover off and back on to fix"). Only touch the DOM on an actual flip.
  let playBtnShows: "play" | "pause" | null = null;
  const updatePlayBtn = (): void => {
    const want = engine.playing ? "pause" : "play";
    if (playBtnShows === want) return;
    playBtnShows = want;
    playBtn.innerHTML = icon(want);
  };
  // Runs on every tick (~60×/s in playback) and every project change, and the
  // readout only moves when the FRAME does. So the duration is walked once per
  // timeline (engine.duration() visits every clip of every track) and the two
  // timecode strings are built only when the frame, the end frame or the rate
  // changed — the theater bar's readout follows the same rule. Times are
  // normalised the way formatTimecode does (non-finite or negative reads 0),
  // so a NaN cannot make the key differ from itself on every tick.
  let durOf: Timeline | null = null;
  let dur = 0;
  let shownFrame = -1;
  let shownEnd = -1;
  let shownFps: Rational | null = null;
  const updateTime = (): void => {
    const tl = session.project.timeline;
    if (tl !== durOf) {
      durOf = tl;
      dur = engine.duration();
    }
    const fps = tl.fps;
    const t = Number.isFinite(engine.time) && engine.time > 0 ? engine.time : 0;
    const end = Number.isFinite(dur) && dur > 0 ? dur : 0;
    const frame = frameOf(t, fps);
    const endFrame = frameOf(end, fps);
    if (frame === shownFrame && endFrame === shownEnd && fps === shownFps) return;
    shownFrame = frame;
    shownEnd = endFrame;
    shownFps = fps;
    timeEl.textContent = `${formatTimecode(t, fps)} / ${formatTimecode(end, fps)}`;
  };

  playBtn.addEventListener("click", () => {
    engine.toggle();
    // A focused <button> treats Space as a native activation (click). If focus
    // stays here after clicking, the next Space fires BOTH this click AND the
    // window "playPause" shortcut → two toggles → no visible change ("pause
    // didn't work"). Blur so Space is owned solely by the ShortcutManager.
    playBtn.blur();
  });
  $("#tr-stop").addEventListener("click", () => engine.stop());
  $("#tr-fullscreen").addEventListener("click", () => theater.toggle());
  $("#tr-step-back").addEventListener("click", () => engine.stepFrames(-1));
  $("#tr-step-fwd").addEventListener("click", () => engine.stepFrames(1));
  $("#tr-split").addEventListener("click", () => actions.split());
  const addMarker = (): void => {
    commit((p) => addMarkerAt(p, engine.time).project);
  };
  $("#tr-marker").addEventListener("click", addMarker);
  $("#tr-add-layer").addEventListener("click", () => {
    commit((p) => addVideoTrack(p).project);
    if (videoTracks(session.project).length > 6) {
      toast.info("More than 6 video layers may affect preview smoothness.");
    }
  });
  $("#tr-zoom-in").addEventListener("click", () => timeline.zoomCentered(1.5));
  $("#tr-zoom-out").addEventListener("click", () => timeline.zoomCentered(1 / 1.5));
  // A <select> keeps focus after a mouse pick, and a focused select counts as
  // a typing target: Space then reopened the dropdown and every shortcut went
  // dead until something else was clicked. So a POINTER pick hands focus back
  // (the play button's rule). A keyboard pick keeps it: on Windows the arrow
  // keys fire change on every step, and blurring there would throw a keyboard
  // user out of the control mid-choice.
  const speedSel = $<HTMLSelectElement>("#tr-speed");
  let speedByKeyboard = false;
  speedSel.addEventListener("keydown", () => {
    speedByKeyboard = true;
  });
  speedSel.addEventListener("pointerdown", () => {
    speedByKeyboard = false;
  });
  speedSel.addEventListener("change", () => {
    engine.setPreviewSpeed(Number(speedSel.value));
    if (!speedByKeyboard) speedSel.blur();
  });

  /* ---------------- monitor volume (transport flyout) ---------------- */

  // Hover the wrapper to reveal the slider; the button itself only toggles mute.
  // Keeping those two gestures separate means a click never fights the flyout.
  const volWrap = $("#tr-volume");
  const volBtn = $<HTMLButtonElement>("#tr-volume-btn");
  const volFlyout = $("#tr-volume-flyout");
  const volSlider = $<HTMLInputElement>("#tr-volume-slider");

  // Same idempotent-glyph discipline as the play button: swap the speaker <svg>
  // only when it crosses the muted↔audible line, never on every drag frame, so a
  // mouse-down that landed on the glyph still pairs with its mouse-up.
  let volBtnMuted: boolean | null = null;
  const reflectVolume = (s: MonitorVolumeState): void => {
    const muted = s.level <= 0;
    if (volBtnMuted !== muted) {
      volBtnMuted = muted;
      volBtn.innerHTML = icon(muted ? "mute" : "volume", 14);
    }
    // don't fight the user's own drag: only write the field they aren't holding
    if (document.activeElement !== volSlider) volSlider.value = String(s.level);
  };
  reflectVolume(volume.get());
  teardown.add(volume.subscribe(reflectVolume));

  // The flyout is open while the wrapper is hovered OR holds focus (keyboard
  // reach: a Tab user can step from the speaker into the range input). Derived
  // from both flags so blurring the speaker after a mute click — needed so Space
  // stays owned by the ShortcutManager — doesn't hide a still-hovered slider.
  let volHover = false;
  let volFocus = false;
  const syncFlyout = (): void => {
    const open = volHover || volFocus;
    volFlyout.hidden = !open;
    volBtn.setAttribute("aria-expanded", String(open));
  };
  volWrap.addEventListener("pointerenter", () => {
    volHover = true;
    syncFlyout();
  });
  volWrap.addEventListener("pointerleave", () => {
    volHover = false;
    syncFlyout();
  });
  volWrap.addEventListener("focusin", () => {
    volFocus = true;
    syncFlyout();
  });
  volWrap.addEventListener("focusout", (e) => {
    if (volWrap.contains(e.relatedTarget as Node)) return;
    volFocus = false;
    syncFlyout();
  });
  volSlider.addEventListener("input", () => volume.setLevel(Number(volSlider.value)));
  volBtn.addEventListener("click", () => {
    volume.toggleMute();
    volBtn.blur();
  });

  loopBtn.addEventListener("click", () => {
    engine.loop = !engine.loop;
    loopBtn.classList.toggle("btn--on", engine.loop);
  });
  snapBtn.addEventListener("click", () => {
    snapOn = !snapOn;
    snapBtn.classList.toggle("btn--on", snapOn);
  });

  teardown.add(
    engine.onTick(() => {
      updateTime();
      updatePlayBtn();
    }),
  );
  updateTime();

  /* ---------------- timeline panel height ---------------- */

  // The panel was a fixed 280px, which leaves ~231px of lanes once the transport
  // row is subtracted — cramped as soon as a project has a few layers, on a
  // maximised window that has hundreds of spare pixels above it. Its height is
  // now the user's: dragged from the divider on its top edge, and kept.
  //
  // The height is written to ONE element and nothing else is notified. The stage
  // and the timeline canvas each already refit from their own ResizeObserver, so
  // the letterbox and the canvas's DPR backing store follow the new box on their
  // own — there is no second refit path here to keep in step with theirs.
  const tlPanel = $(".timeline-panel");
  const tlMain = $(".editor__main");
  const tlHandle = $("#ed-tl-resize");

  // The stage floor, from the same constant the drag clamps against (see the
  // note in editor.css). With it, a stored height too tall for THIS window
  // renders capped by flex instead of pushing the transport off the bottom —
  // and is left alone in settings, so the height comes back in full on the
  // window it was chosen for.
  $("#ed-stage").style.minHeight = `${PREVIEW_MIN_H}px`;
  // Sanitised on read already; clamped again here because this is the value that
  // reaches a style write, and "NaNpx" would silently leave the stylesheet's.
  tlPanel.style.height = `${clampPanelHeight(settingsStore.get().timelineHeight, TIMELINE_HEIGHT_MAX)}px`;

  // One pointerdown listener is the entire cost of this feature to someone who
  // never touches the divider: no observers, no timers, nothing scheduled. Every
  // listener below is created on the gesture and destroyed with it.
  let tlResizeCleanup: (() => void) | null = null;
  // Teardown mid-drag: the divider's own listeners die with the element, but
  // the window keydown and the pending frame do not.
  teardown.add(() => tlResizeCleanup?.());
  tlHandle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || tlResizeCleanup) return;
    e.preventDefault();

    // Measured ONCE, like the media-row drag: the panel's bottom edge is the
    // anchor the pointer sizes against and .editor__main fixes the ceiling.
    // Neither can move while a pointer is captured here, so re-reading them per
    // move would buy nothing and cost a forced layout of the editor tree.
    const panelBottom = tlPanel.getBoundingClientRect().bottom;
    const maxH = maxPanelHeight(tlMain.getBoundingClientRect().height);
    // The exact pre-drag declaration, restored verbatim if the drag is
    // abandoned — not the measured height, which differs from it whenever flex
    // is capping a stored value.
    const beforeH = tlPanel.style.height;
    const pointerId = e.pointerId;

    let next: number | null = null;
    let applied: number | null = null;
    let raf = 0;
    // A pointer can report faster than the compositor paints, and every apply
    // costs a stage refit plus a canvas resize. Coalesce to one per frame.
    const flush = (): void => {
      raf = 0;
      if (next === null || next === applied) return;
      applied = next;
      tlPanel.style.height = `${next}px`;
    };
    const onMove = (ev: PointerEvent): void => {
      const h = clampPanelHeight(panelBottom - ev.clientY, maxH);
      if (h === next) return;
      next = h;
      if (!raf) raf = requestAnimationFrame(flush);
    };
    const end = (keep: boolean): void => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      tlResizeCleanup = null;
      tlHandle.classList.remove("timeline-resize--active");
      tlHandle.removeEventListener("pointermove", onMove);
      tlHandle.removeEventListener("pointerup", onUp);
      tlHandle.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      if (tlHandle.hasPointerCapture(pointerId)) tlHandle.releasePointerCapture(pointerId);
      if (!keep || next === null) {
        tlPanel.style.height = beforeH;
        return;
      }
      // The last move may have been coalesced into the frame just cancelled.
      if (next !== applied) tlPanel.style.height = `${next}px`;
      if (next === settingsStore.get().timelineHeight) return;
      // ONE write, on release: a write per move would be dozens of disk writes a
      // second. And SAY SO if it fails — the panel is already at the new height,
      // so a rejected write otherwise looks exactly like a saved one until the
      // next launch puts it back (same reasoning as the monitor volume above).
      void updateSettings({ timelineHeight: next }).catch((err: unknown) => {
        toast.error("Couldn't save your settings.", {
          detail: describeError(err),
          op: "Settings",
          title: "Timeline height",
        });
      });
    };
    const onUp = (): void => end(true);
    const onCancel = (): void => end(false);
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      end(false);
    };

    // Capture keeps the drag alive when the pointer leaves the 6px band, which
    // it does immediately. It throws for a synthesized/inactive pointer (the
    // autotest harness), and a throw here would leave the gesture half-armed
    // with no way to end it — the drag still works without it because every
    // listener below lives on the handle itself. Same guard as overlay.ts.
    try {
      tlHandle.setPointerCapture(pointerId);
    } catch {
      /* synthetic pointer */
    }
    tlHandle.classList.add("timeline-resize--active");
    tlHandle.addEventListener("pointermove", onMove);
    tlHandle.addEventListener("pointerup", onUp);
    tlHandle.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
    tlResizeCleanup = () => end(false);
  });

  /* ---------------- media panel (readiness list) ---------------- */

  const mediaList = $("#media-list");
  function statusHtml(m: MediaRef): string {
    const s = media.status.get()[m.id];
    if (!s || s.state === "checking") return `<span class="media-row__status">Checking</span>`;
    switch (s.state) {
      case "ready":
        return `<span class="media-row__status media-row__status--ok">Ready</span>`;
      case "preparing": {
        const pct = s.ratio === null ? "" : ` ${Math.round(s.ratio * 100)}%`;
        // The fill is emitted EMPTY and UNSTYLED — `paintMediaRows` sizes it
        // immediately below. Its width cannot live here: the packaged build's
        // style-src names a nonce (tauri stamps index.html's <style> and
        // replace_csp_nonce rewrites the directive), which under CSP3 makes
        // 'unsafe-inline' in that directive inert, and a style ATTRIBUTE cannot
        // carry a nonce. Nor can it live in editor.css — width IS the progress.
        return `<span class="media-row__status">Preparing${pct}</span>
          <div class="media-row__bar"><div></div></div>`;
      }
      case "failed":
        return `<span class="media-row__status media-row__status--bad" title="${escapeHtml(s.message)}">Failed</span>`;
    }
  }

  /** The media array the bin last rendered. A project change rebuilds the bin
   *  only when this differs: clip edits — every pointermove of a canvas drag,
   *  every step of a slider scrub — keep `project.media`'s identity, and the
   *  rebuild they used to cost re-created every row and re-decoded every
   *  thumbnail at pointer rate for a bin that had not changed. Recorded here
   *  rather than compared against the store's `prev`, so a rebuild owed to the
   *  status or thumbnail maps keeps it current as well. */
  let shownMedia: MediaRef[] | null = null;

  function renderMedia(): void {
    const items = session.project.media;
    shownMedia = items;
    if (items.length === 0) {
      mediaList.innerHTML = `<div class="empty-state">${icon("film", 24)}<div class="faint">No media yet.<br/>Drop files anywhere.</div></div>`;
      return;
    }
    const thumbs = media.thumbs.get();
    mediaList.innerHTML = items
      .map((m) => {
        const gen = m.generator;
        let thumb: string;
        let sub: string;
        // The one naming rule the timeline and the inspector share, so a clip
        // reads the same in the bin as everywhere else.
        const name = mediaDisplayName(m);
        if (gen) {
          sub = gen.type;
          // Swatch emitted empty for the same reason as the progress fill above;
          // `paintMediaRows` fills it. And NOT via a `background: var(--accent)`
          // style rule as a shortcut — this is a literal colour the user picked
          // for this generator, and `html[data-rescue-appearance]` re-points the
          // theme tokens inside some containers, which would show the escape
          // hatch's palette instead of the pick.
          thumb =
            gen.type === "solid"
              ? `<div class="media-row__swatch"></div>`
              : gen.type === "drawing"
                ? `<span class="gen-glyph gen-glyph--lg">✎</span>`
                : `<span class="gen-glyph gen-glyph--lg">T</span>`;
        } else {
          sub = m.kind;
          thumb = thumbs[m.id]
            ? `<img src="${escapeHtml(mediaUrl(thumbs[m.id]!))}" alt="" />`
            : icon(m.kind === "audio" ? "music" : "film", 18);
        }
        return `
        <div class="media-row" data-id="${escapeHtml(m.id)}" title="${escapeHtml(gen ? name : m.path)}">
          <div class="media-row__thumb">${thumb}</div>
          <div class="media-row__meta">
            <div class="media-row__name">${escapeHtml(name)}</div>
            <div class="media-row__sub">${escapeHtml(sub)}</div>
          </div>
          <div class="media-row__state">${statusHtml(m)}</div>
        </div>`;
      })
      .join("");
    paintMediaRows(items);
  }

  /**
   * Write the two per-row values that cannot survive in the markup — the
   * generator swatch colour and the "Preparing" bar's width — through the CSSOM,
   * which no CSP gates. Called in the same synchronous turn as the innerHTML
   * above, so there is never a painted frame with a blank swatch or a zero-width
   * bar.
   *
   * Indexed rather than queried by id: renderMedia emits exactly one row per
   * item in order, so `children[i]` is `items[i]` and no selector has to escape
   * a media id.
   */
  function paintMediaRows(items: MediaRef[]): void {
    const status = media.status.get();
    const rows = mediaList.children;
    items.forEach((m, i) => {
      const row = rows[i];
      if (!(row instanceof HTMLElement)) return;
      const gen = m.generator;
      if (gen?.type === "solid") {
        const swatch = row.querySelector<HTMLElement>(".media-row__swatch");
        if (swatch) swatch.style.background = gen.color;
      }
      const s = status[m.id];
      if (s?.state === "preparing") {
        const fill = row.querySelector<HTMLElement>(".media-row__bar > div");
        if (fill) fill.style.width = `${Math.round((s.ratio ?? 0.05) * 100)}%`;
      }
    });
  }

  /**
   * The progress-only repaint: a running job's bar width and its "Preparing NN%"
   * label, on rows that are already in the DOM.
   *
   * Why this exists rather than another `renderMedia`: a job republishes the
   * status map ~10 times a second, and the rebuild answer to that throws away
   * and re-creates every row in the bin — thumbnails included, which re-decodes
   * each <img> — while the user is editing. `statusChange` decides when this is
   * the whole of what is owed. The label is written here as well as in
   * `statusHtml` because it carries the percentage: leaving it to the markup
   * alone would freeze the number at whatever the last rebuild happened to see
   * while the bar underneath it kept filling.
   *
   * The bar element is also the proof that the row on screen is the Preparing
   * row this media rendered as — no other status emits one. If it is missing,
   * the DOM has not caught up with a project edit yet, and the rebuild that edit
   * already scheduled owns the row.
   */
  function paintMediaProgress(items: MediaRef[]): void {
    const status = media.status.get();
    const rows = mediaList.children;
    for (let i = 0; i < items.length; i++) {
      const s = status[items[i]!.id];
      if (s?.state !== "preparing") continue;
      const row = rows[i];
      if (!(row instanceof HTMLElement)) continue;
      const fill = row.querySelector<HTMLElement>(".media-row__bar > div");
      if (!fill) continue;
      fill.style.width = `${Math.round((s.ratio ?? 0.05) * 100)}%`;
      const label = row.querySelector<HTMLElement>(".media-row__status");
      if (label) {
        label.textContent =
          s.ratio === null ? "Preparing" : `Preparing ${Math.round(s.ratio * 100)}%`;
      }
    }
  }

  function paintSaveBadge(): void {
    const s = session.saveState.get();
    const badge = $("#ed-save");
    badge.classList.toggle("editor__savestate--error", s === "error");
    // A quick-view (temp) session isn't a real project on disk yet — its
    // autosaves land in the scratch dir. Show "Temporary" so Save-failed is
    // still surfaced but "Saved"/"Edited" don't imply a kept project.
    badge.textContent = session.temp.get()
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
    paintKeep();
  }

  // Keep on the Temporary badge: make a temp project permanent without leaving
  // it. The button exists only while the session is temp — added and removed
  // here, from the same two subscriptions as the badge, so after a Keep (from
  // here OR from the leave prompt) it goes away with no remount. Idempotent:
  // painting twice in one state touches nothing.
  function paintKeep(): void {
    const existing = root.querySelector<HTMLButtonElement>("#ed-keep");
    if (!session.temp.get()) {
      existing?.remove();
      // Nothing left to confirm: an OS open, the window close and Back all go
      // through without a prompt now.
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
      // Blur first: a focused button would take the next Space as a click
      // instead of play/pause (the transport buttons' rule).
      btn.blur();
      // Latched inside: a second click while one runs does nothing, and so
      // does a click while the leave prompt is deciding. Toasts either way.
      void exits.keep();
    });
    $("#ed-save").after(btn);
  }
  const unsubs = [
    session.store.subscribe(() => {
      if (session.project.media !== shownMedia) renderMedia();
      updateTime();
    }),
    // The timeline paints the selection outline, but only repainted for the
    // selections IT made. A click, Escape or double-click on the preview
    // canvas (or the inspector) moved the selection with the timeline still
    // outlining the old clip — and Delete then removed a clip it did not show
    // as selected. requestRender coalesces, so this costs nothing idle.
    selection.subscribe(() => timeline.requestRender()),
    media.status.subscribe((next, prev) => {
      const change = statusChange(prev, next);
      if (change === "none") return;
      if (change === "progress") {
        // Same rows, same states — only the number moved.
        paintMediaProgress(session.project.media);
        return;
      }
      renderMedia();
      engine.refresh(); // proxies finishing may make the current frame playable
    }),
    media.thumbs.subscribe(renderMedia),
    session.saveState.subscribe(paintSaveBadge),
    // Keep flips a temp session to permanent without a remount: the badge has
    // to leave "Temporary" for the normal states on its own.
    session.temp.subscribe(paintSaveBadge),
  ];
  teardown.add(() => {
    for (const u of unsubs) u();
  });
  // Reflect the badge immediately: the initial state is "saved", which won't
  // fire the subscription, so the hard-coded "Saved" would be wrong for a temp
  // session.
  paintSaveBadge();
  renderMedia();

  /* ---------------- media bin: generators, placement, drag & drop ---------------- */

  // The dialogs live on document.body: dispose closes the open one, or an
  // Explorer open would leave it over the next screen, adding into a session
  // that has been torn down (the relink dialog's bug, applied everywhere).
  let closeGenerator: () => void = () => {};
  teardown.add(() => closeGenerator());
  $("#ed-add-text").addEventListener("click", () => {
    closeGenerator = openGeneratorDialog("text", { session, media });
  });
  $("#ed-add-solid").addEventListener("click", () => {
    closeGenerator = openGeneratorDialog("solid", { session, media });
  });

  const mediaById = (id: string): MediaRef | undefined =>
    session.project.media.find((m) => m.id === id);

  // Visual media occupy video lanes; audio media occupy audio lanes. Generated
  // media (kind "image" + generator) are always visual.
  const isVisualMedia = (m: MediaRef): boolean => m.kind !== "audio";

  /** First audio track id, creating one if none exists (within a commit). */
  const audioTrackId = (p: ProjectFile): { project: ProjectFile; trackId: string } => {
    const existing = p.timeline.tracks.find((t) => t.kind === "audio");
    if (existing) return { project: p, trackId: existing.id };
    const r = addAudioTrack(p);
    return { project: r.project, trackId: r.trackId };
  };

  /** Add a bin media as a clip at the playhead (double-click / preview drop). */
  function placeAtPlayhead(m: MediaRef): void {
    const at = engine.time;
    let newId = "";
    commit((p) => {
      if (isVisualMedia(m)) {
        const clip = makeClip(m, at);
        newId = clip.id;
        return insertClip(p, topVideoTrack(p).id, clip);
      }
      const a = audioTrackId(p);
      const clip = makeClip(m, at);
      newId = clip.id;
      return insertClip(a.project, a.trackId, clip);
    });
    if (newId) select(newId);
  }

  /* ---- custom pointer drag & drop from a media row (no HTML5 dnd) ---- */

  let dragCleanup: (() => void) | null = null;
  teardown.add(() => dragCleanup?.());

  function startMediaDrag(m: MediaRef, downX: number, downY: number): void {
    const stageCanvas = stage.canvas;
    let ghost: HTMLElement | null = null;
    let dragging = false;
    // target resolved on each move; committed on pointerup
    let dropTarget:
      | { kind: "timeline"; trackId: string; t: number }
      | { kind: "preview" }
      | null = null;

    const buildGhost = (): void => {
      const g = document.createElement("div");
      g.className = "media-drag-ghost";
      const gen = m.generator;
      const thumbUrl = media.thumbs.get()[m.id];
      let inner: string;
      if (gen) {
        inner =
          gen.type === "solid"
            ? `<span class="media-drag-ghost__swatch"></span>`
            : gen.type === "drawing"
              ? `<span class="gen-glyph">✎</span>`
              : `<span class="gen-glyph">T</span>`;
      } else if (thumbUrl) {
        inner = `<img src="${escapeHtml(mediaUrl(thumbUrl))}" alt="" />`;
      } else {
        inner = icon(m.kind === "audio" ? "music" : "film", 16);
      }
      const label = mediaDisplayName(m);
      g.innerHTML = `<div class="media-drag-ghost__thumb">${inner}</div><span>${escapeHtml(label)}</span>`;
      // The generator's literal colour, through the CSSOM and not the markup:
      // the packaged build's style-src is a nonce policy, so a `style` attribute
      // is refused, and a theme token would show the rescue palette rather than
      // the user's pick. Written before the ghost is in the document, so the
      // first frame it is ever painted in already has it.
      if (gen?.type === "solid") {
        const swatch = g.querySelector<HTMLElement>(".media-drag-ghost__swatch");
        if (swatch) swatch.style.background = gen.color;
      }
      document.body.appendChild(g);
      ghost = g;
    };

    /* The two drop-zone rects, measured ONCE when the drag actually starts.
       Nothing a drag does can move them: the ghost is position:fixed, the
       timeline drop guide is an absolutely-positioned overlay inside the host,
       and --droptarget is an inset outline. They used to be re-read inside
       resolveTarget, i.e. on EVERY pointermove — two forced synchronous layouts
       of the whole editor tree per move, and each read came right after a
       classList write that had just dirtied layout, which is the worst possible
       ordering. A 400-move drag went from 800 forced layouts to 2. */
    let previewRect: DOMRect | null = null;
    let hostRect: DOMRect | null = null;

    /* Where the pointer was on the last move, in client coordinates. The
       auto-scroll tick re-resolves the target from these because scrolling
       slides the lanes under a STATIONARY pointer: the lane under the cursor
       changes with no pointer event to announce it. Same reason interactions.ts
       keeps lastX/lastY for the canvas drag. */
    let lastClientX = 0;
    let lastClientY = 0;

    /* Lane auto-scroll, so a bin item can reach a lane that is scrolled out of
       view. Without it this gesture could only ever drop onto the three or four
       lanes that happen to be on screen, while dragging a clip already on the
       timeline reached all of them — the same drag, two different sets of
       reachable lanes. Built on the first real move (a plain click on a bin row
       must stay free) and torn down in `cleanup`, the drag's single exit. */
    let autoScroll: LaneAutoScroller | null = null;

    const resolveTarget = (clientX: number, clientY: number, pr: DOMRect, tr: DOMRect): void => {
      dropTarget = null;
      stageCanvas.classList.remove("preview__canvas--droptarget");
      ghost?.classList.remove("media-drag-ghost--no");

      // preview canvas first (small, precise)
      if (clientX >= pr.left && clientX <= pr.right && clientY >= pr.top && clientY <= pr.bottom) {
        dropTarget = { kind: "preview" };
        stageCanvas.classList.add("preview__canvas--droptarget");
        autoScroll?.aim(null);
        timeline.clearDropPreview();
        return;
      }

      // timeline host
      if (clientX >= tr.left && clientX <= tr.right && clientY >= tr.top && clientY <= tr.bottom) {
        const localY = clientY - tr.top;
        const localX = clientX - tr.left;
        // Aimed BEFORE the lane lookup, deliberately: the pinned ruler is "above
        // the lanes", so hovering it pulls the stack up at full speed rather
        // than being a dead spot, and the edge band at the bottom pulls down
        // even while no lane resolves there. The host is the canvas's own box,
        // so this local y is the canvas-local y the zone maths expects.
        autoScroll?.aim(localY);
        const lanes = laneLayout(session.project);
        const lane = lanes.find((l) => localY >= l.y && localY < l.y + l.h);
        const kindOk =
          lane && (isVisualMedia(m) ? lane.track.kind === "video" : lane.track.kind === "audio");
        if (lane && kindOk) {
          const rawT = timeline.tOf(localX);
          const snapped = snapTime(
            rawT,
            collectCandidates(session.project, null, engine.time),
            timeline.view.pxPerSec,
            snapOn,
          );
          const t = Math.max(0, snapped.t);
          dropTarget = { kind: "timeline", trackId: lane.track.id, t };
          timeline.setDropPreview(lane.y, lane.h, timeline.xOf(t));
          return;
        }
        // over the timeline but wrong lane/kind → dimmed "no" ghost
        ghost?.classList.add("media-drag-ghost--no");
        timeline.clearDropPreview();
        return;
      }

      // nowhere droppable — including outside the window entirely, which is why
      // the scroll is parked here rather than left running off the last aim.
      autoScroll?.aim(null);
      timeline.clearDropPreview();
    };

    const onMove = (e: PointerEvent): void => {
      if (!dragging) {
        if (Math.abs(e.clientX - downX) < 4 && Math.abs(e.clientY - downY) < 4) return;
        dragging = true;
        // Measure BEFORE the ghost enters the DOM, so drag start costs one
        // layout rather than one plus a re-layout for the appended ghost. Not
        // measured on pointerdown: a plain click on a bin row must stay free.
        previewRect = stageCanvas.getBoundingClientRect();
        hostRect = timeline.hostRect();
        autoScroll = createLaneAutoScroll(timeline, () => {
          // The lanes moved under the pointer: re-resolve from where it actually
          // is, so the target lane and the drop guide keep agreeing with the
          // offset that is now on screen.
          if (previewRect && hostRect) {
            resolveTarget(lastClientX, lastClientY, previewRect, hostRect);
          }
        });
        buildGhost();
      }
      lastClientX = e.clientX;
      lastClientY = e.clientY;
      if (ghost) {
        ghost.style.left = `${e.clientX + 12}px`;
        ghost.style.top = `${e.clientY + 12}px`;
      }
      if (previewRect && hostRect) resolveTarget(e.clientX, e.clientY, previewRect, hostRect);
    };

    const finish = (commitDrop: boolean): void => {
      cleanup();
      if (!commitDrop || !dropTarget) return;
      if (dropTarget.kind === "preview") {
        placeAtPlayhead(m);
        return;
      }
      const { trackId, t } = dropTarget;
      let newId = "";
      commit((p) => {
        const clip = makeClip(m, t);
        newId = clip.id;
        return insertClip(p, trackId, clip);
      });
      if (newId) select(newId);
    };

    const onUp = (): void => finish(true);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    };
    const cleanup = (): void => {
      dragCleanup = null;
      // First and unconditionally: a loop that outlives its drag would keep
      // scrolling a timeline nobody is dragging on. Every exit — pointerup,
      // Escape, and the editor's own dispose — reaches this one function.
      autoScroll?.stop();
      autoScroll = null;
      ghost?.remove();
      stageCanvas.classList.remove("preview__canvas--droptarget");
      timeline.clearDropPreview();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey, true);
    };
    dragCleanup = () => finish(false);

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey, true);
  }

  mediaList.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button")) return; // row has no buttons today, but stay safe
    const row = target.closest<HTMLElement>(".media-row");
    if (!row) return;
    const m = mediaById(row.dataset.id!);
    if (!m) return;
    e.preventDefault();
    if (dragCleanup) dragCleanup();
    startMediaDrag(m, e.clientX, e.clientY);
  });

  mediaList.addEventListener("dblclick", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".media-row");
    if (!row) return;
    const m = mediaById(row.dataset.id!);
    if (m) placeAtPlayhead(m);
  });

  mediaList.addEventListener("contextmenu", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".media-row");
    if (!row) return;
    e.preventDefault();
    const m = mediaById(row.dataset.id!);
    if (m) openMediaMenu(m, e.clientX, e.clientY);
  });

  /** Bin-row context menu: add at playhead, or remove from project (with an
   *  inline confirm reopening the same menu when clips reference the media). */
  function openMediaMenu(m: MediaRef, x: number, y: number): void {
    showMenu(x, y, [
      { label: "Add at playhead", onSelect: () => placeAtPlayhead(m) },
      { label: "Remove from project", danger: true, onSelect: () => removeMedia(m, x, y) },
    ]);
  }

  function removeMedia(m: MediaRef, x: number, y: number): void {
    const p = session.project;
    let refs = 0;
    for (const track of p.timeline.tracks) {
      for (const c of track.clips) if (c.mediaId === m.id) refs++;
    }
    const doCascade = (): void => {
      commit((proj) => removeMediaCascade(proj, m.id));
      // The manager keeps status/waveforms/thumbs for every id it has ever
      // tracked; a removed media would otherwise sit in those maps (waveform
      // peaks included) for the rest of the session.
      media.untrack(m.id);
      // clear selection if it referenced a now-removed clip
      const sel = selectedClipId();
      if (sel && !findClip(session.project, sel)) select(null);
    };
    if (refs === 0) {
      doCascade();
      return;
    }
    showMenu(x, y, [
      {
        label: `Remove media and its ${refs} clip${refs === 1 ? "" : "s"}?`,
        danger: true,
        onSelect: doCascade,
      },
      { label: "Cancel", onSelect: () => {} },
    ]);
  }

  /* ---------------- importing ---------------- */

  // Bin-first import: media lands in the panel only — no clips are created.
  // Drag a bin row to a lane/preview (or double-click) to place it. addMedia
  // still adopts the first visual's resolution/fps.
  //
  // The picker and every probe are awaits the editor can be closed across: an
  // Explorer open forwarded to this window replaces the editor while its
  // Import dialog is still up. A closed editor's session must not take the
  // files (its final save may already be out, or may still write them into a
  // project the user has left), and they must not silently vanish either: the
  // ones it never took in are named in a refusal on the screen that replaced
  // it. The probe is the loop's only await, so checking on entry and after
  // each probe covers every file.
  async function importPaths(paths: string[]): Promise<void> {
    if (disposed()) {
      if (paths.length) toast.refuse(closedImportMessage(paths));
      return;
    }
    const usable = paths.filter((p) => MEDIA_FILE_EXTENSIONS.has(fileExt(p)));
    if (usable.length === 0) {
      toast.refuse("Unsupported file type.");
      return;
    }
    for (let i = 0; i < usable.length; i++) {
      const path = usable[i]!;
      let info: MediaInfo;
      try {
        info = await ipc.probeMedia(path);
      } catch (e) {
        if (disposed()) {
          toast.refuse(closedImportMessage(usable.slice(i)));
          return;
        }
        toast.error(`Couldn't import ${fileStem(path)}: ${describeError(e)}`);
        continue;
      }
      if (disposed()) {
        toast.refuse(closedImportMessage(usable.slice(i)));
        return;
      }
      // The commit runs the engine refresh synchronously: a throw there must
      // cost this one file a message, not escape importPaths (the drop path
      // calls it with `void`, which would leave the rejection unhandled) and
      // not stop the files after it.
      try {
        commit((p) => addMedia(p, info).project);
      } catch (e) {
        toast.error(`Couldn't import ${fileStem(path)}: ${describeError(e)}`);
      }
    }
    media.ensureAll(session.project);
  }

  // Back (to home, or to the viewer it came from) / Ctrl+W, and the Settings
  // gear. A temp session is resolved (kept or discarded) by the gate first —
  // otherwise the editor's dispose would flush edits only to the doomed temp
  // path (silent loss). Cancel stays put. A permanent session passes straight
  // through. Both wait out a badge Keep in flight (see createTempExits).
  const goHome = (): void => exits.confirmLeave(() => navigate(exitDest(route)));
  const goSettings = (): void => exits.confirmLeave(() => navigate({ view: "settings" }));

  $("#ed-home").addEventListener("click", () => goHome());
  $("#ed-settings").addEventListener("click", () => goSettings());
  // The export dialog lives on document.body, so dispose() closes it (a no-op
  // while an export runs — the one state the leave block refuses anyway).
  let closeExport: () => void = () => {};
  teardown.add(() => closeExport());
  const openExport = (): void => {
    closeExport = openExportDialog({ session });
  };
  $("#ed-export").addEventListener("click", openExport);
  $("#ed-import").addEventListener("click", () => {
    // A picker that fails is said so — the chain used to end in an unhandled
    // rejection — unless the editor has closed meanwhile, when there is no
    // screen of its own left to say it on.
    pickMediaFiles()
      .then((files) => (files.length ? importPaths(files) : undefined))
      .catch((e: unknown) => {
        if (!disposed()) toast.error(describeError(e));
      });
  });

  const dropOverlay = $("#ed-drop");
  // `disposed()` closes a real leak: teardown can land while this registration
  // is still in flight. The old code assigned the handle to a no-op
  // placeholder, so teardown unlistened NOTHING and the listener survived for
  // the life of the process — a later drop then fired both the dead handler
  // (committing into a disposed session and toasting from whatever screen the
  // user was now on) and the live editor's. Claim it immediately if teardown
  // already happened.
  let unlistenDrop: (() => void) | null = null;
  teardown.add(() => {
    unlistenDrop?.();
    unlistenDrop = null;
  });
  void onDragDrop({
    onHover: () => dropOverlay.classList.add("active"),
    onCancel: () => dropOverlay.classList.remove("active"),
    onDrop: (paths) => {
      dropOverlay.classList.remove("active");
      void importPaths(paths);
    },
  }).then((u) => {
    if (disposed()) u();
    else unlistenDrop = u;
  });

  /* ---------------- inline project rename (top bar) ---------------- */

  const nameEl = $("#ed-name");
  let renaming = false;

  // Keep the displayed name in sync (undo/redo, autosave name changes).
  const syncName = (): void => {
    if (!renaming) nameEl.textContent = session.project.name;
  };

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
        if (value.length > 0 && value !== current) {
          session.commit((p) => ({ ...p, name: value }));
        }
      }
      nameEl.textContent = session.project.name;
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
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
      // preventDefault does not stop the key reaching the window, where the
      // ShortcutManager listens: Space here started the rename AND toggled
      // playback. The name owns this key press outright.
      e.stopPropagation();
      startRename();
    }
  });
  teardown.add(session.store.subscribe(syncName));

  /* ---------------- shortcuts ---------------- */

  const shortcuts = new ShortcutManager("editor");
  shortcuts.setBindings(settingsStore.get().shortcuts);

  // Modal guard. Nothing else stops a global shortcut from firing behind an open
  // dialog: trapTab only cycles focus, each dialog's own keydown handler takes
  // Escape (+ sometimes Enter) and nothing more, and isTypingTarget returns
  // FALSE for <button>, <body> and checkboxes. So with the export dialog open,
  // clicking any Format button re-renders the form — focus falls back to <body>
  // — and Delete then deleted the selected clip invisibly behind the modal; S
  // split, M dropped a marker, Space started playback.
  //
  // A predicate, not detach()/attach(): dialogs are opened from files this
  // module doesn't own (export, generators, relink, inspector) and none of them
  // report when they close (the closers some return only take them down, for
  // dispose), so an attach/detach pair would need a new seam in each — and
  // would silently regress the moment someone adds a dialog. `.modal-backdrop` is the app-wide modal marker (every dialog in the
  // tree builds one) and home.ts already guards its Esc handler exactly this
  // way. Cost is one querySelector per BOUND chord press, i.e. human-rate.
  // Every dialog in the app builds a `.modal-backdrop`, so this covers current
  // and future modals with no per-dialog wiring — none of them reports its
  // close to hook. Held by the manager rather than each handler so a
  // suppressed chord is not preventDefault()ed either: before this, pressing
  // Delete with the export dialog open silently deleted the selected clip
  // behind it, and Space started playback.
  //
  // THIS IS NO LONGER THE ONLY GUARD, and it is the older of the two. It only
  // ever saw modals, because a class name is only found by something that
  // already knows to look for it — the context menu has no backdrop, and every
  // chord fired behind an open one (see `blockShortcuts` in core/shortcuts).
  // Surfaces now register themselves; the manager checks the registry as well
  // as this predicate. Keep the predicate for the dialogs above, which are not
  // this module's to change, and DO NOT extend it with more class names — a new
  // floating surface should take a token instead.
  const modalOpen = (): boolean => document.querySelector(".modal-backdrop") !== null;
  shortcuts.setSuppressed(modalOpen);
  const bind = (action: ActionId, handler: () => void): void => shortcuts.on(action, handler);

  bind("playPause", () => engine.toggle());
  bind("stop", () => engine.stop());
  bind("stepFwd", () => engine.stepFrames(1));
  bind("stepBack", () => engine.stepFrames(-1));
  bind("jumpFwd", () => engine.jumpSeconds(1));
  bind("jumpBack", () => engine.jumpSeconds(-1));
  bind("goStart", () => engine.seek(0));
  bind("goEnd", () => engine.seek(engine.duration()));
  bind("split", () => actions.split());
  bind("delete", () => actions.remove());
  bind("rippleDelete", () => actions.ripple());
  bind("undo", () => actions.undo());
  bind("redo", () => actions.redo());
  bind("redoAlt", () => actions.redo());
  bind("save", () => void session.save());
  bind("copy", () => actions.copy());
  bind("paste", () => actions.paste());
  bind("toggleSnap", () => snapBtn.click());
  bind("toggleLoop", () => loopBtn.click());
  bind("addMarker", addMarker);
  bind("export", openExport);
  bind("goHome", () => goHome());
  bind("fullscreen", () => theater.toggle());
  shortcuts.attach();
  teardown.add(() => shortcuts.detach());

  teardown.add(settingsStore.subscribe((s) => shortcuts.setBindings(s.shortcuts)));

  // show the first frame
  engine.seek(0);
  graph.tick(engine.time, engine.playing, engine.previewSpeed);

  // Offer to relink any media whose file is missing/changed on disk. The
  // dialog lives on document.body, so dispose closes it: a navigation that
  // leaves this editor (an Explorer open) must not leave it over the next
  // screen, relinking into a project nobody saves.
  if (loaded.missing.length > 0) {
    teardown.add(openRelinkDialog({ session, media, missing: loaded.missing }));
  }

  // dev hook for the in-app autotest harness
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__tarotingDev = {
      engine,
      session,
      media,
      timeline,
      audioGraph: graph,
      scheduler,
      activeVideo: (): HTMLVideoElement | null => scheduler.activeVideo(),
    };
  }

  return {
    async dispose() {
      // The teardown ui/menu documents every screen owing it. The host div lives
      // on document.body, which a route change never clears, so a menu open at
      // teardown would survive onto the next screen still pointing at this one's
      // callbacks — and, now that an open menu holds the keyboard, would leave
      // the next editor's shortcuts inert until something dismissed it.
      closeMenu();
      // Everything registered above, newest first: the dialogs this screen
      // opened, its shortcuts and subscriptions, then the timeline, overlay,
      // theater and playback stack. It also flips `disposed()`, so a picker or
      // probe still out refuses instead of committing.
      teardown.run();
      // A discarded quick-view project will never be opened again, so the
      // remux or proxy it started has no one to finish for: cancel it rather
      // than leave one transcode queued per file stepped through. A kept or
      // permanent project lets them run on into the cache for its next open.
      media.dispose({ cancelPlayback: session.discarded });
      // Only clear what is still ours: a newer mount may already have claimed
      // currentSession, and nulling it would strip that screen's leave guard.
      if (currentSession.get() === session) currentSession.set(null);
      await session.dispose();
    },
  };
}
