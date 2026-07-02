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
  findClip,
  importMediaAsClip,
  insertClip,
  removeClip,
  rippleDelete,
  splitClip,
  uid,
  updateClip,
} from "../core/project";
import { ProjectSession, currentSession, settingsStore } from "../core/session";
import { ShortcutManager } from "../core/shortcuts";
import { Store } from "../core/store";
import { clipEnd, locate } from "../core/time";
import { MEDIA_FILE_EXTENSIONS } from "../core/types";
import type { Clip, MediaInfo, MediaRef } from "../core/types";
import { icon } from "../ui/icons";
import { showMenu } from "../ui/menu";
import { toast } from "../ui/toast";
import { openExportDialog } from "./export/export-dialog";
import { mountInspector } from "./inspector/inspector";
import { MediaManager } from "./media/media";
import { openRelinkDialog } from "./media/relink";
import { AudioGraph } from "./playback/audio-graph";
import { PlaybackEngine } from "./playback/engine";
import { Scheduler } from "./playback/scheduler";
import { mountStage } from "./preview/preview";
import { TimelineController } from "./timeline/timeline";

export async function mountEditor(
  root: HTMLElement,
  projectPath: string,
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
  const media = new MediaManager(() => session.project);
  await media.init();
  media.ensureAll(session.project);

  if (loaded.recovered) toast.info("Project restored from its automatic backup.");

  /* ---------------- layout ---------------- */

  root.innerHTML = `
    <div class="editor">
      <div class="editor__topbar">
        <button class="btn btn--ghost btn--icon" id="ed-home" title="Back to projects">${icon("chevronLeft")}</button>
        <div class="editor__name">${escapeHtml(session.project.name)}</div>
        <div class="editor__savestate" id="ed-save">Saved</div>
        <div class="grow"></div>
        <button class="btn" id="ed-import">${icon("plus")}Import media</button>
        <button class="btn btn--ghost btn--icon" id="ed-settings" title="Settings">${icon("gear")}</button>
        <button class="btn btn--primary" id="ed-export" title="Export (Ctrl+E)">${icon("export")}Export</button>
      </div>
      <div class="editor__body">
        <aside class="media-panel">
          <div class="media-panel__header no-select">Media</div>
          <div class="media-list" id="media-list"></div>
        </aside>
        <div class="editor__main">
          <div class="editor__preview" id="ed-stage"></div>
          <div class="timeline-panel">
            <div class="transport no-select">
              <button class="btn btn--ghost btn--icon btn--sm" id="tr-step-back" title="Previous frame (←)">${icon("stepBack", 14)}</button>
              <button class="btn btn--icon" id="tr-play" title="Play/Pause (Space)">${icon("play")}</button>
              <button class="btn btn--ghost btn--icon btn--sm" id="tr-step-fwd" title="Next frame (→)">${icon("stepFwd", 14)}</button>
              <button class="btn btn--ghost btn--icon btn--sm" id="tr-stop" title="Stop">${icon("stop", 14)}</button>
              <div class="transport__time mono" id="tr-time">00:00:00</div>
              <div class="grow"></div>
              <select class="select select--sm" id="tr-speed" title="Playback speed">
                <option value="0.25">0.25×</option>
                <option value="0.5">0.5×</option>
                <option value="1" selected>1×</option>
                <option value="1.5">1.5×</option>
                <option value="2">2×</option>
              </select>
              <button class="btn btn--ghost btn--icon btn--sm" id="tr-loop" title="Loop playback (L)">${icon("loop", 14)}</button>
              <button class="btn btn--ghost btn--icon btn--sm btn--on" id="tr-snap" title="Snapping (N)">${icon("magnet", 14)}</button>
              <button class="btn btn--ghost btn--icon btn--sm" id="tr-split" title="Split at playhead (S)">${icon("scissors", 14)}</button>
              <button class="btn btn--ghost btn--icon btn--sm" id="tr-marker" title="Add marker (M)">${icon("flag", 14)}</button>
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
  // before the engine exists — route it through a mutable ref.
  let engineRef: PlaybackEngine | null = null;
  const stage = mountStage($("#ed-stage"), session.project, () => engineRef?.refresh());
  const scheduler = new Scheduler(stage, () => session.project, media);
  const engine = new PlaybackEngine(() => session.project, scheduler);
  engineRef = engine;

  const graph = new AudioGraph(() => session.project, media, scheduler);
  const unGraphTick = engine.onTick((t, playing) => graph.tick(t, playing, engine.previewSpeed));

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
      engine.refresh();
      timeline.requestRender();
    },
    redo(): void {
      session.redo();
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
      { label: "Replace media…", onSelect: () => void replaceClipMedia(clip) },
      { label: "Delete", onSelect: () => actions.remove() },
      { label: "Ripple delete", danger: true, onSelect: () => actions.ripple() },
    ]);
  }

  /* ---------------- transport ---------------- */

  const playBtn = $("#tr-play");
  const timeEl = $("#tr-time");
  const loopBtn = $("#tr-loop");
  const snapBtn = $("#tr-snap");

  const updatePlayBtn = (): void => {
    playBtn.innerHTML = icon(engine.playing ? "pause" : "play");
  };
  const updateTime = (): void => {
    const fps = engine.fps();
    timeEl.textContent = `${formatTimecode(engine.time, fps)} / ${formatTimecode(engine.duration(), fps)}`;
  };

  playBtn.addEventListener("click", () => engine.toggle());
  $("#tr-stop").addEventListener("click", () => engine.stop());
  $("#tr-step-back").addEventListener("click", () => engine.stepFrames(-1));
  $("#tr-step-fwd").addEventListener("click", () => engine.stepFrames(1));
  $("#tr-split").addEventListener("click", () => actions.split());
  const addMarker = (): void => {
    commit((p) => addMarkerAt(p, engine.time).project);
  };
  $("#tr-marker").addEventListener("click", addMarker);
  $("#tr-zoom-in").addEventListener("click", () => timeline.zoomCentered(1.5));
  $("#tr-zoom-out").addEventListener("click", () => timeline.zoomCentered(1 / 1.5));
  $("#tr-speed").addEventListener("change", (e) => {
    engine.setPreviewSpeed(Number((e.target as HTMLSelectElement).value));
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

  /* ---------------- media panel (readiness list) ---------------- */

  const mediaList = $("#media-list");
  function statusHtml(m: MediaRef): string {
    const s = media.status.get()[m.id];
    if (!s || s.state === "checking") return `<span class="media-row__status">Checking…</span>`;
    switch (s.state) {
      case "ready":
        return `<span class="media-row__status media-row__status--ok">Ready</span>`;
      case "preparing": {
        const pct = s.ratio === null ? "" : ` ${Math.round(s.ratio * 100)}%`;
        return `<span class="media-row__status">Preparing${pct}</span>
          <div class="media-row__bar"><div style="width:${Math.round((s.ratio ?? 0.05) * 100)}%"></div></div>`;
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
        const thumb = thumbs[m.id]
          ? `<img src="${escapeHtml(mediaUrl(thumbs[m.id]!))}" alt="" />`
          : icon(m.kind === "audio" ? "music" : "film", 18);
        return `
        <div class="media-row" title="${escapeHtml(m.path)}">
          <div class="media-row__thumb">${thumb}</div>
          <div class="media-row__meta">
            <div class="media-row__name">${escapeHtml(fileStem(m.path))}</div>
            <div class="media-row__sub">${m.kind}</div>
          </div>
          <div class="media-row__state">${statusHtml(m)}</div>
        </div>`;
      })
      .join("");
  }

  const unsubs = [
    session.store.subscribe(() => {
      renderMedia();
      updateTime();
    }),
    media.status.subscribe(() => {
      renderMedia();
      engine.refresh(); // proxies finishing may make the current frame playable
    }),
    media.thumbs.subscribe(renderMedia),
    session.saveState.subscribe((s) => {
      const badge = $("#ed-save");
      badge.classList.toggle("editor__savestate--error", s === "error");
      badge.textContent =
        s === "saved" ? "Saved" : s === "saving" ? "Saving…" : s === "dirty" ? "Edited" : "Save failed";
    }),
  ];
  renderMedia();

  /* ---------------- importing ---------------- */

  async function importPaths(paths: string[]): Promise<void> {
    const usable = paths.filter((p) => MEDIA_FILE_EXTENSIONS.has(fileExt(p)));
    if (usable.length === 0) {
      toast.error("Unsupported file type.");
      return;
    }
    for (const path of usable) {
      try {
        const info: MediaInfo = await ipc.probeMedia(path);
        commit((p) => importMediaAsClip(p, info).project);
      } catch (e) {
        toast.error(`Couldn't import ${fileStem(path)}: ${describeError(e)}`);
      }
    }
    media.ensureAll(session.project);
    timeline.fit();
  }

  $("#ed-home").addEventListener("click", () => navigate({ view: "home" }));
  $("#ed-settings").addEventListener("click", () => navigate({ view: "settings" }));
  $("#ed-export").addEventListener("click", () => openExportDialog({ session }));
  $("#ed-import").addEventListener("click", () => {
    void pickMediaFiles().then((files) => {
      if (files.length) void importPaths(files);
    });
  });

  const dropOverlay = $("#ed-drop");
  let unlistenDrop: () => void = () => {};
  void onDragDrop({
    onHover: () => dropOverlay.classList.add("active"),
    onCancel: () => dropOverlay.classList.remove("active"),
    onDrop: (paths) => {
      dropOverlay.classList.remove("active");
      void importPaths(paths);
    },
  }).then((u) => (unlistenDrop = u));

  /* ---------------- shortcuts ---------------- */

  const shortcuts = new ShortcutManager();
  shortcuts.setBindings(settingsStore.get().shortcuts);
  shortcuts.on("playPause", () => engine.toggle());
  shortcuts.on("stop", () => engine.stop());
  shortcuts.on("stepFwd", () => engine.stepFrames(1));
  shortcuts.on("stepBack", () => engine.stepFrames(-1));
  shortcuts.on("jumpFwd", () => engine.jumpSeconds(1));
  shortcuts.on("jumpBack", () => engine.jumpSeconds(-1));
  shortcuts.on("goStart", () => engine.seek(0));
  shortcuts.on("goEnd", () => engine.seek(engine.duration()));
  shortcuts.on("split", () => actions.split());
  shortcuts.on("delete", () => actions.remove());
  shortcuts.on("rippleDelete", () => actions.ripple());
  shortcuts.on("undo", () => actions.undo());
  shortcuts.on("redo", () => actions.redo());
  shortcuts.on("save", () => void session.save());
  shortcuts.on("copy", () => actions.copy());
  shortcuts.on("paste", () => actions.paste());
  shortcuts.on("toggleSnap", () => snapBtn.click());
  shortcuts.on("toggleLoop", () => loopBtn.click());
  shortcuts.on("addMarker", addMarker);
  shortcuts.on("export", () => openExportDialog({ session }));
  shortcuts.on("goHome", () => navigate({ view: "home" }));
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
      activeVideo: (): HTMLVideoElement | null => {
        if (stage.videoA.pos.style.display !== "none") return stage.videoA.media;
        if (stage.videoB.pos.style.display !== "none") return stage.videoB.media;
        return null;
      },
    };
  }

  return {
    async dispose() {
      shortcuts.detach();
      unsubSettings();
      unTick();
      unGraphTick();
      for (const u of unsubs) u();
      unlistenDrop();
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
