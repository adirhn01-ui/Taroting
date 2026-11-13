// The video editor's SCRUB COPY: while the playhead is dragged over a heavy
// clip with the timeline paused (the ruler or empty-area scrub, a marker drag,
// the fullscreen seek bar), each visible layer of that clip shows the frame
// under the pointer from a small all-keyframe copy made in the background
// (src-tauri/src/media/scrub.rs). At rest or on release each copy stays up
// until its layer's real element shows the exact frame, then hides.
//
// The rules:
//  1. Playback is not touched. This module is handed READ-ONLY views of the
//     engine (time, playing, onTick) and the scheduler (visibleClipsAt): it
//     cannot seek, play or pause, and it never writes to an element it did
//     not create. The real elements get exactly the writes they get without
//     it.
//  2. A project with no possible heavy video (`isCandidate`: a video file
//     whose bit rate reaches the shared threshold) takes one identity check
//     per project change: no tick listener, no pointer listener, no timer, no
//     element, no backend call.
//  3. A candidate's PLAYED file is weighed (one keyframe-index read) after
//     the paused playhead rests DWELL_MS on a clip of it, or at once on a
//     pointer press while one is under the playhead.
//  4. A drag is told apart from every other seek WITHOUT touching the
//     timeline or the theater: a window capture listener keeps the pointer
//     event being dispatched, and a tick counts as the pointer's when it runs
//     inside that dispatch (`eventPhase` is not NONE) and the project is the
//     one the previous tick saw. Any other tick (a frame step, a key, a
//     button, an edit, an edit made inside a pointer handler such as an
//     on-canvas move) hides every copy at once, so a step always shows the
//     real file. The one exception: an edit that changes no picture (a
//     marker dropped) at an unmoved playhead is let pass.
//  5. Paused only: a drag that starts while playing is today's drag, and the
//     first playing tick lets go of every copy.
//  6. Failures are silent and per file; the reason is kept for the dev hook.
//
// The pieces: precheck.ts (pure), copy-registry.ts (per file), copy-layers.ts
// (per layer element). This file wires them to the editor.

import type { DamageState, MediaState } from "../media/media";
import type { VisibleClip } from "../playback/scheduler";
import type { JobEventHandlers, KeyframeIndex, ScrubPlan } from "../../core/ipc";
import type { MediaRef, ProjectFile } from "../../core/types";
import { ScrubCopyLayers, type CopyLayerSnapshot, type CopyTimers, type SlotView } from "./copy-layers";
import { ScrubCopyRegistry, type CopyFileSnapshot } from "./copy-registry";
import { DWELL_MS, REST_MS, isCandidate, layerTargets, liveFiles, type LayerTarget } from "./precheck";

/** What the module may read of the playback engine (no transport). */
export interface EngineView {
  readonly time: number;
  readonly playing: boolean;
  onTick(fn: (time: number, playing: boolean) => void): () => void;
}

/** What the module may read of the scheduler. */
export interface ClipsView {
  visibleClipsAt(t: number): VisibleClip[];
}

export interface ReadStore<T> {
  get(): T;
  subscribe(fn: (state: T, prev: T) => void): () => void;
}

export interface MediaView {
  readonly status: ReadStore<Record<string, MediaState>>;
  readonly damage: ReadStore<Record<string, DamageState>>;
}

/** The stage's layer sets (index 0 topmost); only the two video slots. */
export interface StageView {
  readonly layers: readonly { readonly videoA: SlotView; readonly videoB: SlotView }[];
}

export interface ScrubIpc {
  keyframeTimes(path: string): Promise<KeyframeIndex | null>;
  planScrub(path: string): Promise<ScrubPlan>;
  cancelJob(id: number): Promise<unknown>;
  onJobEvents(h: JobEventHandlers): Promise<() => void>;
  mediaUrl(path: string): string;
}

/** The part of `window` the drag detection needs. */
export interface PointerTarget {
  addEventListener(type: string, fn: (e: Event) => void, capture: boolean): void;
  removeEventListener(type: string, fn: (e: Event) => void, capture: boolean): void;
}

export interface EditorScrubDeps {
  engine: EngineView;
  clips: ClipsView;
  stage: StageView;
  media: MediaView;
  getProject(): ProjectFile;
  /** Called on every project change; returns the unsubscribe. */
  subscribeProject(fn: () => void): () => void;
  ipc: ScrubIpc;
  win?: PointerTarget;
  timers?: CopyTimers;
  raf?: (fn: () => void) => void;
  createVideo?: () => HTMLVideoElement;
}

export interface EditorScrubSnapshot {
  files: CopyFileSnapshot[];
  layers: CopyLayerSnapshot[];
  indexCalls: number;
  planCalls: number;
  cancels: number;
  /** The window pointer listener is installed. */
  listening: boolean;
  /** The engine tick listener is installed. */
  ticking: boolean;
}

/** DEV / E2E seams (published on the editor's dev hook in a dev build only). */
export interface EditorScrubDev {
  /** Every video counts as a candidate and every index as heavy (the index
   *  must still be read and have keyframes). */
  forceHeavy: boolean;
  /** With `forceHeavy`, force only the media recorded at this path (and the
   *  file of that path); null forces every video. */
  forceOnly: string | null;
  /** The module behaves as if absent. */
  disabled: boolean;
  failNextPlan(reason: string): void;
  snapshot(): EditorScrubSnapshot;
  /** Layer `idx`'s copy element, if one was made. */
  copy(idx: number): HTMLVideoElement | null;
}

export interface EditorScrub {
  dispose(): void;
  dev: EditorScrubDev;
}

/** The edit from `a` to `b` cannot change a frame on the stage: the same
 *  media, tracks and canvas (a marker moved, the export preset changed). */
function samePicture(a: ProjectFile, b: ProjectFile): boolean {
  const x = a.timeline;
  const y = b.timeline;
  return (
    a.media === b.media &&
    x.tracks === y.tracks &&
    x.width === y.width &&
    x.height === y.height &&
    x.fps.num === y.fps.num &&
    x.fps.den === y.fps.den
  );
}

/** `Event.NONE`, spelled out (the unit tests run without a DOM). */
const PHASE_NONE = 0;

const defaultTimers: CopyTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id) => globalThis.clearTimeout(id),
};

/** A copy element: muted, CORS-clean, styled inline (no stylesheet), out of
 *  the pointer's way, hidden until shown. Fitted like the real element (a
 *  <video>'s default `object-fit: contain`, which the stage never overrides):
 *  both pictures have the source's display aspect, so a non-square-pixel or
 *  rotated source lands in the same place in the same box. */
function createCopyVideo(): HTMLVideoElement {
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  v.crossOrigin = "anonymous";
  v.setAttribute("aria-hidden", "true");
  v.dataset["scrubCopy"] = "";
  v.style.cssText =
    "position:absolute;left:0;top:0;display:none;max-width:none;max-height:none;pointer-events:none;object-fit:contain";
  return v;
}

/** The layer's video slot that shows `url` now, or null (a gap, an image, a
 *  generator, or a slot loading something else). */
function shownSlot(set: { videoA: SlotView; videoB: SlotView } | undefined, url: string): SlotView | null {
  if (set === undefined) return null;
  for (const s of [set.videoA, set.videoB]) {
    if (s.pos.style.display !== "none" && s.media.getAttribute("src") === url) return s;
  }
  return null;
}

export function mountEditorScrub(deps: EditorScrubDeps): EditorScrub {
  const { engine, clips, stage, media, getProject } = deps;
  const ipc = deps.ipc;
  const timers = deps.timers ?? defaultTimers;
  const win = (): PointerTarget => deps.win ?? (window as unknown as PointerTarget);

  let force = false;
  let forceOnly: string | null = null;
  const samePath = (a: string, b: string): boolean => a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();
  const forcedMedia = (m: MediaRef): boolean => force && (forceOnly === null || samePath(m.path, forceOnly));
  const forcedFile = (file: string): boolean => force && (forceOnly === null || samePath(file, forceOnly));
  let disabled = false;
  let disposed = false;
  /** The candidate media ids. */
  let candidates = 0;
  let mediaSeen: readonly MediaRef[] | null = null;
  let active = false;
  let offTick: (() => void) | null = null;
  let offStatus: (() => void) | null = null;
  let listening = false;
  let dragListening = false;

  /** The pointer event being (or last) dispatched. */
  let evt: Event | null = null;
  let held = false;
  let pointerSeeks = 0;
  let pressT = Number.NaN;
  let playingAtPress = false;
  let playingSeen = false;
  let dwellTimer: number | undefined;
  let restTimer: number | undefined;
  let tickFailed = false;
  /** The project the last tick (or project change) saw, and the last tick's
   *  time: a pointer-dispatched tick under a different project is an edit's
   *  refresh, not a seek. */
  let tickProject: ProjectFile | null = null;
  let lastT = Number.NaN;

  const layers = new ScrubCopyLayers({
    createVideo: deps.createVideo ?? createCopyVideo,
    stalled: (file, reason) => registry.fail(file, reason),
    elementError: (file, detail) => registry.elementError(file, detail),
    timers,
    ...(deps.raf ? { raf: deps.raf } : {}),
  });

  const registry: ScrubCopyRegistry = new ScrubCopyRegistry({
    keyframeTimes: (file) => ipc.keyframeTimes(file),
    plan: (file) => ipc.planScrub(file),
    cancel: (id) => void ipc.cancelJob(id).catch(() => {}),
    listen: (h) =>
      ipc.onJobEvents({
        onDone: (e) => h.done(e.id, typeof e.output["path"] === "string" ? e.output["path"] : null),
        onFailed: (e) => h.failed(e.id, e.message),
      }),
    url: (p) => ipc.mediaUrl(p),
    released: (_file, url) => {
      if (url !== null) layers.releaseUrl(url);
    },
    changed: () => {
      // A copy that became ready under a resting playhead is loaded ahead.
      if (active && !engine.playing) preloadAt(engine.time);
    },
  });

  /* ---------------- targets ---------------- */

  const targetsAt = (t: number): (LayerTarget | null)[] =>
    layerTargets(getProject(), media.status.get(), media.damage.get(), clips.visibleClipsAt(t), t, forcedMedia);

  const filesOf = (targets: readonly (LayerTarget | null)[]): string[] => {
    const out: string[] = [];
    for (const tg of targets) if (tg !== null && !out.includes(tg.file)) out.push(tg.file);
    return out;
  };

  function askAt(t: number): void {
    const files = filesOf(targetsAt(t));
    if (files.length > 0) registry.ask(files);
  }

  function preloadAt(t: number): void {
    const targets = targetsAt(t);
    for (let i = 0; i < targets.length; i++) {
      const tg = targets[i];
      if (!tg) continue;
      const url = registry.readyUrl(tg.file);
      const slot = shownSlot(stage.layers[i], tg.url);
      if (url !== null && slot !== null) layers.preload(i, slot, url, tg.file);
    }
  }

  /** A pointer-caused, paused tick: every layer follows or hides. */
  function follow(t: number): void {
    const targets = targetsAt(t);
    const n = Math.max(stage.layers.length, targets.length, layers.extent());
    let unknown: string[] | null = null;
    for (let i = 0; i < n; i++) {
      const tg = i < stage.layers.length ? (targets[i] ?? null) : null;
      if (tg === null) {
        layers.hide(i);
        continue;
      }
      if (registry.state(tg.file) === null) (unknown ??= []).push(tg.file);
      const url = registry.readyUrl(tg.file);
      const slot = url === null ? null : shownSlot(stage.layers[i], tg.url);
      if (url === null || slot === null) {
        layers.hide(i);
        continue;
      }
      layers.follow(i, slot, url, tg.file, tg.srcT);
    }
    if (unknown !== null) registry.ask(unknown);
  }

  /* ---------------- timers ---------------- */

  function clearDwell(): void {
    timers.clearTimeout(dwellTimer);
    dwellTimer = undefined;
  }

  function armDwell(): void {
    clearDwell();
    dwellTimer = timers.setTimeout(() => {
      dwellTimer = undefined;
      if (!active || engine.playing) return;
      askAt(engine.time);
      preloadAt(engine.time);
    }, DWELL_MS);
  }

  function clearRest(): void {
    timers.clearTimeout(restTimer);
    restTimer = undefined;
  }

  function armRest(): void {
    clearRest();
    restTimer = timers.setTimeout(() => {
      restTimer = undefined;
      if (held) layers.rest();
    }, REST_MS);
  }

  /* ---------------- the engine's ticks ---------------- */

  function tick(t: number, playing: boolean): void {
    if (playing) {
      if (!playingSeen) {
        playingSeen = true;
        clearDwell();
        clearRest();
        layers.setPlaying(true);
      }
      return;
    }
    if (playingSeen) {
      playingSeen = false;
      layers.setPlaying(false);
    }
    armDwell();
    const project = getProject();
    const before = tickProject;
    tickProject = project;
    const prevT = lastT;
    lastT = t;
    const pointer = evt !== null && evt.eventPhase !== PHASE_NONE;
    if (pointer && before !== null && project !== before) {
      // An edit refreshed the engine inside a pointer handler (an on-canvas
      // move or scale, an inspector drag, a marker dropped): not a scrub.
      if (t === prevT && samePicture(before, project)) return;
      clearRest();
      layers.interrupt();
      return;
    }
    if (!pointer) {
      clearRest();
      layers.interrupt();
      return;
    }
    pointerSeeks++;
    // Moved = the playhead left the press's position (a pointer moving along
    // the ruler without changing the time is not a move).
    if (pointerSeeks === 1) pressT = t;
    else if (t !== pressT) layers.setMoved();
    if (playingAtPress) return;
    follow(t);
    if (pointerSeeks >= 2 && held) armRest();
  }

  /** The engine's listener: whatever goes wrong here must never reach the
   *  seek that emitted the tick. */
  const onTick = (t: number, playing: boolean): void => {
    try {
      tick(t, playing);
    } catch (e) {
      if (!tickFailed) {
        tickFailed = true;
        console.error("editor scrub copy: a tick failed; the copies are off for this editor", e);
        layers.unloadAll();
        setActive(false);
      }
    }
  };

  /* ---------------- the pointer ---------------- */

  const onDown = (e: Event): void => {
    if ((e as PointerEvent).button !== 0) return;
    evt = e;
    held = true;
    pointerSeeks = 0;
    playingAtPress = engine.playing;
    clearRest();
    layers.press(playingAtPress);
    if (!dragListening) {
      dragListening = true;
      const w = win();
      w.addEventListener("pointermove", onMove, true);
      w.addEventListener("pointerup", onUp, true);
      w.addEventListener("pointercancel", onUp, true);
    }
    if (!playingAtPress) {
      try {
        askAt(engine.time);
      } catch (err) {
        console.error("editor scrub copy: asking on a press failed", err);
      }
    }
  };

  const onMove = (e: Event): void => {
    evt = e;
  };

  const onUp = (e: Event): void => {
    evt = e;
    release();
  };

  function stopDragListening(): void {
    if (!dragListening) return;
    dragListening = false;
    const w = win();
    w.removeEventListener("pointermove", onMove, true);
    w.removeEventListener("pointerup", onUp, true);
    w.removeEventListener("pointercancel", onUp, true);
  }

  function release(): void {
    stopDragListening();
    clearRest();
    if (!held) return;
    held = false;
    layers.release();
  }

  /* ---------------- the candidate gate ---------------- */

  function setActive(on: boolean): void {
    if (on === active) return;
    active = on;
    if (on) {
      offTick = engine.onTick(onTick);
      offStatus = media.status.subscribe(() => reconcile());
      win().addEventListener("pointerdown", onDown, true);
      listening = true;
      playingSeen = engine.playing;
      tickProject = getProject();
      lastT = engine.time;
      armDwell();
      return;
    }
    offTick?.();
    offTick = null;
    offStatus?.();
    offStatus = null;
    if (listening) {
      listening = false;
      win().removeEventListener("pointerdown", onDown, true);
    }
    stopDragListening();
    clearDwell();
    clearRest();
    held = false;
    evt = null;
    layers.unloadAll();
  }

  function recompute(): void {
    let n = 0;
    for (const m of getProject().media) if (isCandidate(m, forcedMedia(m))) n++;
    candidates = n;
    setActive(!disposed && !disabled && !tickFailed && candidates > 0);
  }

  function reconcile(): void {
    registry.reconcile(liveFiles(getProject(), media.status.get()));
  }

  function onProject(): void {
    tickProject = getProject();
    const list = getProject().media;
    if (list === mediaSeen) return;
    mediaSeen = list;
    recompute();
    reconcile();
  }

  const offProject = deps.subscribeProject(onProject);
  onProject();

  const dev: EditorScrubDev = {
    get forceHeavy(): boolean {
      return force;
    },
    set forceHeavy(on: boolean) {
      force = on;
      registry.setForce(forcedFile);
      recompute();
    },
    get forceOnly(): string | null {
      return forceOnly;
    },
    set forceOnly(path: string | null) {
      forceOnly = path;
      registry.setForce(forcedFile);
      recompute();
    },
    get disabled(): boolean {
      return disabled;
    },
    set disabled(on: boolean) {
      disabled = on;
      recompute();
    },
    failNextPlan: (reason) => registry.failNextPlan(reason),
    snapshot: () => ({
      files: registry.snapshot(),
      layers: layers.snapshot(),
      indexCalls: registry.indexCalls,
      planCalls: registry.planCalls,
      cancels: registry.cancels,
      listening,
      ticking: offTick !== null,
    }),
    copy: (idx) => layers.element(idx),
  };

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      offProject();
      setActive(false);
      registry.dispose();
      layers.dispose();
    },
    dev,
  };
}
