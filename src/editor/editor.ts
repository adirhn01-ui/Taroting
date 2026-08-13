// Editor shell: session (autosave/undo), media manager, preview stage,
// playback engine, canvas timeline, transport bar, and keyboard shortcuts.

import "./editor.css";
import { escapeHtml, fileExt, fileStem, formatTimecode } from "../core/format";
import { describeError, ipc, mediaUrl, onDragDrop, pickMediaFiles } from "../core/ipc";
import { navigate } from "../core/nav";
import {
  addAudioTrack,
  addMarkerAt,
  addMedia,
  addVideoTrack,
  findClip,
  findMedia,
  findTrack,
  insertClip,
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
import { ProjectSession, currentSession, settingsStore, updateSettings } from "../core/session";
import { ShortcutManager } from "../core/shortcuts";
import { Store } from "../core/store";
import { clipEnd, locate } from "../core/time";
import { MEDIA_FILE_EXTENSIONS, TIMELINE_HEIGHT_MAX } from "../core/types";
import type { ActionId, Clip, MediaInfo, MediaRef, ProjectFile, Track } from "../core/types";
import { icon } from "../ui/icons";
import { closeMenu, showMenu } from "../ui/menu";
import { toast } from "../ui/toast";
import { openExportDialog } from "./export/export-dialog";
import { mountInspector } from "./inspector/inspector";
import { openGeneratorDialog } from "./media/generators";
import { MediaManager } from "./media/media";
import { openRelinkDialog } from "./media/relink";
import { statusChange } from "./media/status-diff";
import {
  AudioGraph,
  makeMonitorVolume,
  setMonitorLevel,
  toggleMonitorMute,
} from "./playback/audio-graph";
import type { MonitorVolumeState } from "./playback/audio-graph";
import { PlaybackEngine } from "./playback/engine";
import { Scheduler } from "./playback/scheduler";
import { mountStage } from "./preview/preview";
import { mountCanvasOverlay } from "./preview/overlay";
import { mountTheater } from "./preview/theater";
import { collectCandidates, snapTime } from "./timeline/snap";
import { laneLabels, laneLayout } from "./timeline/render";
import { createLaneAutoScroll, type LaneAutoScroller } from "./timeline/interactions";
import { trapTab } from "../ui/focus";
import { PREVIEW_MIN_H, clampPanelHeight, maxPanelHeight } from "./timeline/panel-size";
import { TimelineController } from "./timeline/timeline";

export async function mountEditor(
  root: HTMLElement,
  projectPath: string,
  temp = false,
): Promise<{ dispose(): Promise<void> }> {
  let loaded;
  try {
    loaded = await ipc.loadProject(projectPath);
  } catch (e) {
    toast.error(describeError(e));
    navigate({ view: "home" });
    return { dispose: async () => {} };
  }

  const session = new ProjectSession(projectPath, loaded.project);
  currentSession.set(session);
  // A quick-view session is a throwaway file that startup cleanup deletes, so
  // ANY route away from it must offer keep-or-discard first. Back/Ctrl+W/gear
  // already call confirmLeaveTemp directly; this guard covers the one path that
  // did not — an OS "open with" request arriving from File Explorer, which
  // navigated straight past the prompt and silently destroyed the work.
  // (confirmLeaveTemp is a hoisted declaration; the guard only runs later.)
  if (temp) {
    session.leaveGuard = () =>
      new Promise<boolean>((resolve) =>
        confirmLeaveTemp(
          () => resolve(true),
          () => resolve(false),
        ),
      );
  }
  const media = new MediaManager(() => session.project);
  await media.init();
  media.ensureAll(session.project);

  if (loaded.recovered) toast.info("Project restored from its automatic backup.");

  /* ---------------- layout ---------------- */

  root.innerHTML = `
    <div class="editor">
      <div class="editor__topbar">
        <button class="btn btn--ghost btn--icon" id="ed-home" title="Back to projects">${icon("chevronLeft")}</button>
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
  const scheduler = new Scheduler(stage, () => session.project, media);
  const engine = new PlaybackEngine(() => session.project, scheduler);
  engineRef = engine;

  const graph = new AudioGraph(() => session.project, media, scheduler);
  const unGraphTick = engine.onTick((t, playing) => graph.tick(t, playing, engine.previewSpeed));

  /* ---------------- monitor (preview listening) volume ---------------- */

  // Single source of truth for the preview LISTENING level, shared by the
  // transport flyout and the theater bar. It scales the audio graph's master
  // bus only — never per-clip audio, the project, or exports. Seeded from the
  // persisted Settings.monitorVolume; every change applies to the graph, is
  // persisted via updateSettings, and notifies both UIs so they stay in sync.
  let volState: MonitorVolumeState = makeMonitorVolume(settingsStore.get().monitorVolume);
  graph.setMonitorVolume(volState.level);
  const volSubs = new Set<(s: MonitorVolumeState) => void>();
  // Persisting to disk on every drag frame would be dozens of writes/sec; the
  // graph apply is immediate (smooth audio) but the settings write is debounced
  // so only the settled level lands on disk.
  let volSaveTimer: number | undefined;
  let volSavePending = false;
  const flushVolumeSave = (): void => {
    window.clearTimeout(volSaveTimer);
    if (!volSavePending) return;
    volSavePending = false;
    // SAY SO if the write fails. The slider already shows the new level (the
    // graph is updated before the IPC is even issued), so a bare `void` here
    // left a rejected write looking exactly like a successful one — silent
    // until the next launch reverted it. Same shape as settings.ts persist().
    void updateSettings({ monitorVolume: volState.level }).catch((e: unknown) => {
      toast.error("Couldn't save your settings.", {
        detail: describeError(e),
        op: "Settings",
        title: "Monitor volume",
      });
    });
  };
  const applyVolume = (next: MonitorVolumeState): void => {
    volState = next;
    graph.setMonitorVolume(next.level);
    volSavePending = true;
    window.clearTimeout(volSaveTimer);
    volSaveTimer = window.setTimeout(flushVolumeSave, 300);
    for (const fn of volSubs) fn(next);
  };
  const volume = {
    get: (): MonitorVolumeState => volState,
    setLevel: (v: number): void => applyVolume(setMonitorLevel(volState, v)),
    toggleMute: (): void => applyVolume(toggleMonitorMute(volState)),
    subscribe(fn: (s: MonitorVolumeState) => void): () => void {
      volSubs.add(fn);
      return () => volSubs.delete(fn);
    },
  };

  // Refit the stage when the project canvas w/h changes (resolution adoption,
  // canvas settings). Cheap: compares two numbers per project change.
  let stageW = session.project.timeline.width;
  let stageH = session.project.timeline.height;
  const unRefit = session.store.subscribe(() => {
    const { width, height } = session.project.timeline;
    if (width !== stageW || height !== stageH) {
      stageW = width;
      stageH = height;
      stage.refit();
    }
  });

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

  const inspector = mountInspector($("#ed-inspector"), {
    session,
    media,
    engine,
    selection,
    refresh: () => {
      engine.refresh();
      timeline.requestRender();
    },
  });

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
  });

  // Fullscreen playback (theater mode). Lives on the preview container so it can
  // lift the whole stage over the editor chrome; the transport button glyph flips
  // to reflect the open/close state via onChange.
  const theater = mountTheater({
    engine,
    container: $("#ed-stage"),
    volume,
    onChange: (on) => {
      const btn = $("#tr-fullscreen");
      btn.innerHTML = icon(on ? "fullscreenExit" : "fullscreen", 14);
      btn.title = on ? "Exit fullscreen (F)" : "Fullscreen (F)";
    },
    // refit the letterbox on every theater/fullscreen size transition so the
    // video scales crisply to the new container box (the ResizeObserver alone
    // can race the fixed inset-0 jump).
    refit: () => stage.refit(),
  });

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
        const pasted: Clip = { ...clip, id: uid(), timelineStart: at };
        return insertClip(proj, trackId, pasted);
      });
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
  // point the clip's mediaId at it, resetting srcIn and clamping srcOut to the
  // new source length (images keep their footprint). No confirmation.
  async function replaceClipMedia(clip: Clip): Promise<void> {
    const files = await pickMediaFiles();
    const path = files[0];
    if (!path) return;
    let info: MediaInfo;
    try {
      info = await ipc.probeMedia(path);
    } catch (e) {
      toast.error(`Couldn't read ${fileStem(path)}: ${describeError(e)}`);
      return;
    }
    commit((p) => {
      const added = addMedia(p, info);
      return updateClip(added.project, clip.id, (c) => ({
        ...c,
        mediaId: added.media.id,
        srcIn: 0,
        srcOut:
          info.kind === "image" ? c.srcOut - c.srcIn : Math.min(info.duration, c.srcOut - c.srcIn),
      }));
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
      { label: "Replace media", onSelect: () => void replaceClipMedia(clip) },
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
  // to confirm first (undoable either way).
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
            confirmDeleteLayer(label, n, () => deleteLayer(track.id, true));
          }
        },
      },
    ]);
  }

  // Destructive confirm for deleting a non-empty layer. Reuses the app modal
  // pattern + trapTab (as in home.ts / generators.ts).
  function confirmDeleteLayer(label: string, n: number, onConfirm: () => void): void {
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
          <button class="btn btn--danger" data-act="confirm">Delete</button>
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
      } else if (e.key === "Enter") {
        e.preventDefault();
        confirm();
      }
    }
    document.addEventListener("keydown", onKey, true);
    backdrop.addEventListener("pointerdown", (e) => {
      if (e.target === backdrop) close();
    });
    backdrop.querySelector('[data-act="cancel"]')!.addEventListener("click", close);
    backdrop.querySelector('[data-act="confirm"]')!.addEventListener("click", confirm);
    requestAnimationFrame(() => backdrop.querySelector<HTMLButtonElement>('[data-act="confirm"]')!.focus());
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
  const updateTime = (): void => {
    const fps = engine.fps();
    timeEl.textContent = `${formatTimecode(engine.time, fps)} / ${formatTimecode(engine.duration(), fps)}`;
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
  $("#tr-speed").addEventListener("change", (e) => {
    engine.setPreviewSpeed(Number((e.target as HTMLSelectElement).value));
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
  const unVolume = volume.subscribe(reflectVolume);

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

  const unTick = engine.onTick(() => {
    updateTime();
    updatePlayBtn();
  });
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

  function renderMedia(): void {
    const items = session.project.media;
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
        let name: string;
        if (gen) {
          name = gen.type === "text" ? gen.text || "Text" : "Solid";
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
              : `<span class="gen-glyph gen-glyph--lg">T</span>`;
        } else {
          name = fileStem(m.path);
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

  const unsubs = [
    session.store.subscribe(() => {
      renderMedia();
      updateTime();
    }),
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
    session.saveState.subscribe((s) => {
      const badge = $("#ed-save");
      badge.classList.toggle("editor__savestate--error", s === "error");
      // A quick-view (temp) session isn't a real project on disk yet — its
      // autosaves land in the scratch dir. Show "Temporary" so Save-failed is
      // still surfaced but "Saved"/"Edited" don't imply a kept project.
      badge.textContent = temp
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
    }),
  ];
  // Reflect the temp badge immediately: the initial state is "saved", which
  // won't fire the subscription, so the hard-coded "Saved" would otherwise show.
  if (temp) $("#ed-save").textContent = "Temporary";
  renderMedia();

  /* ---------------- media bin: generators, placement, drag & drop ---------------- */

  $("#ed-add-text").addEventListener("click", () =>
    openGeneratorDialog("text", { session, media }),
  );
  $("#ed-add-solid").addEventListener("click", () =>
    openGeneratorDialog("solid", { session, media }),
  );

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
            : `<span class="gen-glyph">T</span>`;
      } else if (thumbUrl) {
        inner = `<img src="${escapeHtml(mediaUrl(thumbUrl))}" alt="" />`;
      } else {
        inner = icon(m.kind === "audio" ? "music" : "film", 16);
      }
      const label = gen ? (gen.type === "text" ? gen.text || "Text" : "Solid") : fileStem(m.path);
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
  async function importPaths(paths: string[]): Promise<void> {
    const usable = paths.filter((p) => MEDIA_FILE_EXTENSIONS.has(fileExt(p)));
    if (usable.length === 0) {
      toast.error("Unsupported file type.");
      return;
    }
    for (const path of usable) {
      try {
        const info: MediaInfo = await ipc.probeMedia(path);
        commit((p) => addMedia(p, info).project);
      } catch (e) {
        toast.error(`Couldn't import ${fileStem(path)}: ${describeError(e)}`);
      }
    }
    media.ensureAll(session.project);
  }

  // Promote a live quick-view (temp) session to a permanent project. This is the
  // "Keep project" gesture from the leave-the-editor confirmation (shared by Back,
  // Ctrl+W and the Settings gear): save the project permanently to
  // Documents\Taroting (which runs the standard recents + thumbnail upsert). The
  // temp scratch file is left for startup cleanup.
  //
  // Save-loop until stable: `session.project` is `store.get()`, and EVERY mutation
  // path (commit/replace/undo/redo and autosave's touchModified stamp) swaps the
  // store reference (see core/session.ts), so an edit landing between our read and
  // the save's completion changes the reference. We re-save until the reference we
  // saved still matches the current one — otherwise that late edit would live only
  // in the doomed temp file (lost-update).
  async function keepTempProject(): Promise<void> {
    const permPath = await ipc.newProjectPath(session.project.name);
    let snap: typeof session.project;
    do {
      snap = session.project;
      await ipc.saveProject(permPath, snap);
    } while (snap !== session.project);
  }

  // Best-effort discard of the temp scratch file. `session.discard()` runs FIRST
  // so the editor's dispose flush (which targets this same temp path) can't
  // resurrect the file after we delete it. deleteProject fail-softs: a locked
  // file is caught by startup cleanup. The media original is never touched — only
  // the throwaway .trt (+ its .bak) go. No recents entry exists for a temp path,
  // so deleteProject's recents-retain is a harmless no-op.
  async function discardTempProject(): Promise<void> {
    session.discard();
    try {
      await ipc.deleteProject(session.path);
    } catch {
      // Fail-soft: the temp file stays for the next startup's temp-dir sweep.
    }
  }

  // `keeping` guards the WHOLE leave lifecycle for a temp session — from opening
  // the confirmation to its resolution. It blocks a second modal (Back then gear
  // while one is open does nothing) and any double promotion/discard. Cleared on
  // every close path: cancel, keep (success or error → stay), and discard.
  let keeping = false;

  // Confirm leaving a temp quick-view: Keep promotes then navigates, Discard
  // deletes then navigates, Cancel stays put with no side effects. Reuses the app
  // modal pattern + trapTab (as in the delete-layer / home delete dialogs).
  // `onCancel` MUST fire on every path that does not reach `dest()`, including
  // the re-entrancy bail below: an OS open-path request awaits this decision, and
  // a promise that never settles would stall the open queue for the rest of the
  // session.
  function confirmLeaveTemp(dest: () => void, onCancel?: () => void): void {
    if (keeping) {
      onCancel?.();
      return;
    }
    keeping = true;

    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="Keep temporary project?">
        <div class="modal__header"><span>Keep temporary project?</span><button class="btn btn--ghost btn--icon btn--sm" data-act="cancel" title="Cancel" aria-label="Cancel">${icon("x", 14)}</button></div>
        <div class="modal__body">
          <div class="modal__text">This project was opened as a quick view and isn't in your library yet. Keep it, or discard it? Discarding removes only this temporary copy — your media file is untouched.</div>
        </div>
        <div class="modal__footer">
          <button class="btn" data-act="discard">Discard</button>
          <button class="btn btn--primary" data-act="keep">Keep project</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);

    const releaseTrap = trapTab(backdrop);
    let closed = false;
    // Cancel path: tear the modal down and release the lifecycle guard so a later
    // Back/gear can re-open it. Nothing is saved or deleted — stay in the editor.
    const close = (): void => {
      if (closed) return;
      closed = true;
      releaseTrap();
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      keeping = false;
      onCancel?.();
    };
    // Commit path (keep/discard): tear down the modal but KEEP the guard held —
    // the async promote/delete is still in flight and must not be re-entered.
    const dismiss = (): void => {
      if (closed) return;
      closed = true;
      releaseTrap();
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
    };
    const keep = async (): Promise<void> => {
      dismiss();
      try {
        await keepTempProject();
      } catch (e) {
        keeping = false;
        toast.error(`Couldn't save this project: ${describeError(e)}`);
        onCancel?.();
        return; // stay in the editor so the work isn't lost silently
      }
      dest();
    };
    const discard = async (): Promise<void> => {
      dismiss();
      await discardTempProject();
      dest();
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
    backdrop.querySelector('[data-act="keep"]')!.addEventListener("click", () => void keep());
    backdrop.querySelector('[data-act="discard"]')!.addEventListener("click", () => void discard());
    requestAnimationFrame(() =>
      backdrop.querySelector<HTMLButtonElement>('[data-act="keep"]')!.focus(),
    );
  }

  // Back to home / Ctrl+W. For a temp session, confirm keep-or-discard first;
  // both outcomes navigate home, Cancel stays. Non-temp: straight navigate.
  function goHome(): void {
    if (!temp) {
      navigate({ view: "home" });
      return;
    }
    confirmLeaveTemp(() => navigate({ view: "home" }));
  }

  // Settings gear: a temp session must be resolved (kept or discarded) before
  // navigating away, or the editor's dispose would flush edits only to the doomed
  // temp path (silent loss). Non-temp: straight navigate.
  function goSettings(): void {
    if (!temp) {
      navigate({ view: "settings" });
      return;
    }
    confirmLeaveTemp(() => navigate({ view: "settings" }));
  }

  $("#ed-home").addEventListener("click", () => goHome());
  $("#ed-settings").addEventListener("click", () => goSettings());
  $("#ed-export").addEventListener("click", () => openExportDialog({ session }));
  $("#ed-import").addEventListener("click", () => {
    void pickMediaFiles().then((files) => {
      if (files.length) void importPaths(files);
    });
  });

  const dropOverlay = $("#ed-drop");
  // `disposed` closes a real leak: dispose() can land while this registration is
  // still in flight. The old code assigned the handle to a no-op placeholder, so
  // teardown unlistened NOTHING and the listener survived for the life of the
  // process — a later drop then fired both the dead handler (committing into a
  // disposed session and toasting from whatever screen the user was now on) and
  // the live editor's. Claim it immediately if teardown already happened.
  let disposed = false;
  let unlistenDrop: (() => void) | null = null;
  void onDragDrop({
    onHover: () => dropOverlay.classList.add("active"),
    onCancel: () => dropOverlay.classList.remove("active"),
    onDrop: (paths) => {
      dropOverlay.classList.remove("active");
      void importPaths(paths);
    },
  }).then((u) => {
    if (disposed) u();
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
      startRename();
    }
  });
  const unName = session.store.subscribe(syncName);

  /* ---------------- shortcuts ---------------- */

  const shortcuts = new ShortcutManager();
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
  // expose a close callback to re-attach on, so an attach/detach pair would need
  // a new seam in each — and would silently regress the moment someone adds a
  // dialog. `.modal-backdrop` is the app-wide modal marker (every dialog in the
  // tree builds one) and home.ts already guards its Esc handler exactly this
  // way. Cost is one querySelector per BOUND chord press, i.e. human-rate.
  // Every dialog in the app builds a `.modal-backdrop`, so this covers current
  // and future modals with no per-dialog wiring — none of them expose a close
  // callback to hook. Held by the manager rather than each handler so a
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
  bind("save", () => void session.save());
  bind("copy", () => actions.copy());
  bind("paste", () => actions.paste());
  bind("toggleSnap", () => snapBtn.click());
  bind("toggleLoop", () => loopBtn.click());
  bind("addMarker", addMarker);
  bind("export", () => openExportDialog({ session }));
  bind("goHome", () => goHome());
  bind("fullscreen", () => theater.toggle());
  shortcuts.attach();

  const unsubSettings = settingsStore.subscribe((s) => shortcuts.setBindings(s.shortcuts));

  // show the first frame
  engine.seek(0);
  graph.tick(engine.time, engine.playing, engine.previewSpeed);

  // Offer to relink any media whose file is missing/changed on disk.
  if (loaded.missing.length > 0) {
    openRelinkDialog({ session, media, missing: loaded.missing });
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
      disposed = true;
      // The teardown ui/menu documents every screen owing it. The host div lives
      // on document.body, which a route change never clears, so a menu open at
      // teardown would survive onto the next screen still pointing at this one's
      // callbacks — and, now that an open menu holds the keyboard, would leave
      // the next editor's shortcuts inert until something dismissed it.
      closeMenu();
      shortcuts.detach();
      unsubSettings();
      unTick();
      unGraphTick();
      unVolume();
      flushVolumeSave();
      unRefit();
      unName();
      // Teardown mid-drag: the divider's own listeners die with the element, but
      // the window keydown and the pending frame do not.
      tlResizeCleanup?.();
      if (dragCleanup) dragCleanup();
      for (const u of unsubs) u();
      unlistenDrop?.();
      unlistenDrop = null;
      theater.dispose();
      overlay.dispose();
      inspector.dispose();
      timeline.dispose();
      engine.dispose();
      graph.dispose();
      stage.dispose();
      media.dispose();
      currentSession.set(null);
      await session.dispose();
    },
  };
}
