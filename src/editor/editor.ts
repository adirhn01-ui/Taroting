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
  insertClip,
  makeClip,
  removeClip,
  removeMediaCascade,
  rippleDelete,
  splitClip,
  topVideoTrack,
  uid,
  updateClip,
  videoTracks,
} from "../core/project";
import { ProjectSession, currentSession, settingsStore } from "../core/session";
import { ShortcutManager } from "../core/shortcuts";
import { Store } from "../core/store";
import { clipEnd, locate } from "../core/time";
import { MEDIA_FILE_EXTENSIONS } from "../core/types";
import type { Clip, MediaInfo, MediaRef, ProjectFile } from "../core/types";
import { icon } from "../ui/icons";
import { showMenu } from "../ui/menu";
import { toast } from "../ui/toast";
import { openExportDialog } from "./export/export-dialog";
import { mountInspector } from "./inspector/inspector";
import { openGeneratorDialog } from "./media/generators";
import { MediaManager } from "./media/media";
import { openRelinkDialog } from "./media/relink";
import { AudioGraph } from "./playback/audio-graph";
import { PlaybackEngine } from "./playback/engine";
import { Scheduler } from "./playback/scheduler";
import { mountStage } from "./preview/preview";
import { mountCanvasOverlay } from "./preview/overlay";
import { collectCandidates, snapTime } from "./timeline/snap";
import { laneLayout } from "./timeline/render";
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

  playBtn.addEventListener("click", () => {
    engine.toggle();
    // A focused <button> treats Space as a native activation (click). If focus
    // stays here after clicking, the next Space fires BOTH this click AND the
    // window "playPause" shortcut → two toggles → no visible change ("pause
    // didn't work"). Blur so Space is owned solely by the ShortcutManager.
    playBtn.blur();
  });
  $("#tr-stop").addEventListener("click", () => engine.stop());
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
        const gen = m.generator;
        let thumb: string;
        let sub: string;
        let name: string;
        if (gen) {
          name = gen.type === "text" ? gen.text || "Text" : "Solid";
          sub = gen.type;
          thumb =
            gen.type === "solid"
              ? `<div class="media-row__swatch" style="background:${escapeHtml(gen.color)}"></div>`
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
            ? `<span class="media-drag-ghost__swatch" style="background:${escapeHtml(gen.color)}"></span>`
            : `<span class="gen-glyph">T</span>`;
      } else if (thumbUrl) {
        inner = `<img src="${escapeHtml(mediaUrl(thumbUrl))}" alt="" />`;
      } else {
        inner = icon(m.kind === "audio" ? "music" : "film", 16);
      }
      const label = gen ? (gen.type === "text" ? gen.text || "Text" : "Solid") : fileStem(m.path);
      g.innerHTML = `<div class="media-drag-ghost__thumb">${inner}</div><span>${escapeHtml(label)}</span>`;
      document.body.appendChild(g);
      ghost = g;
    };

    const resolveTarget = (clientX: number, clientY: number): void => {
      dropTarget = null;
      stageCanvas.classList.remove("preview__canvas--droptarget");
      ghost?.classList.remove("media-drag-ghost--no");

      // preview canvas first (small, precise)
      const pr = stageCanvas.getBoundingClientRect();
      if (clientX >= pr.left && clientX <= pr.right && clientY >= pr.top && clientY <= pr.bottom) {
        dropTarget = { kind: "preview" };
        stageCanvas.classList.add("preview__canvas--droptarget");
        timeline.clearDropPreview();
        return;
      }

      // timeline host
      const tr = timeline.hostRect();
      if (clientX >= tr.left && clientX <= tr.right && clientY >= tr.top && clientY <= tr.bottom) {
        const localY = clientY - tr.top;
        const localX = clientX - tr.left;
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

      // nowhere droppable
      timeline.clearDropPreview();
    };

    const onMove = (e: PointerEvent): void => {
      if (!dragging) {
        if (Math.abs(e.clientX - downX) < 4 && Math.abs(e.clientY - downY) < 4) return;
        dragging = true;
        buildGhost();
      }
      if (ghost) {
        ghost.style.left = `${e.clientX + 12}px`;
        ghost.style.top = `${e.clientY + 12}px`;
      }
      resolveTarget(e.clientX, e.clientY);
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
      scheduler,
      activeVideo: (): HTMLVideoElement | null => scheduler.activeVideo(),
    };
  }

  return {
    async dispose() {
      shortcuts.detach();
      unsubSettings();
      unTick();
      unGraphTick();
      unRefit();
      unName();
      if (dragCleanup) dragCleanup();
      for (const u of unsubs) u();
      unlistenDrop();
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
