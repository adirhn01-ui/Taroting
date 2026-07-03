// Canvas direct-manipulation overlay (plan D3). A single .stage-overlay div over
// the preview canvas hosts a selection box (border + 4 corner handles) and the
// crop chrome (dim veil, ghost outline, 8 handles). Click selects the topmost
// clip under the playhead; drag/scale edit position and scale (auto-keyed when
// the clip already animates that prop group); double-click enters Slides-style
// crop mode whose three gestures are the closed-form ops from canvas-math.ts.
//
// Performance: children are created ONCE and toggled; per-tick work is a handful
// of style writes, gated so they only fire when the underlying values changed.
// Nothing here runs — the overlay stays display:none — unless something is
// selected or crop mode is open.

import { sourceTime } from "../../core/time";
import type { Clip, ClipTransform, MediaRef, ProjectFile } from "../../core/types";
import type { Store } from "../../core/store";
import { defaultTransform, findClip, setKeyframe, setPositionKeyframes, updateClip } from "../../core/project";
import { evalKfs } from "../../core/anim";
import { mediaUrl } from "../../core/ipc";
import { settingsStore } from "../../core/session";
import type { Scheduler } from "../playback/scheduler";
import type { PlaybackEngine } from "../playback/engine";
import type { ProjectSession } from "../../core/session";
import type { Stage } from "./preview";
import {
  type Axis,
  type PoseState,
  type WindowHandle,
  axisMatrix,
  clampCrop,
  displayRect,
  fit,
  ghostDrag,
  ghostResize,
  snapToCenter,
  windowHandleDrag,
  SCALE_MAX,
  SCALE_MIN,
} from "./canvas-math";

export interface OverlayCtx {
  stage: Stage;
  scheduler: Scheduler;
  engine: PlaybackEngine;
  session: ProjectSession;
  selection: Store<string | null>;
  refresh(): void;
}

const CORNER_HANDLES: WindowHandle[] = ["nw", "ne", "se", "sw"];
const ALL_HANDLES: WindowHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

// Center-snap catch radius, in SCREEN px. Divided by the stage scale at drag
// time to get the project-px threshold, so the snap zone is a constant on-screen
// distance regardless of how large the canvas is rendered.
const SNAP_SCREEN_PX = 8;

/** setPointerCapture throws for synthesized/inactive pointers (autotest); the
 *  gesture still works because our listeners live on the overlay element. */
function capture(el: HTMLElement, pointerId: number): void {
  try { el.setPointerCapture(pointerId); } catch { /* synthetic pointer */ }
}

/** Resolved pose of a clip at a timeline time, honoring keyframes. Everything in
 *  project-canvas px / source px, pre stage scale. */
interface ResolvedPose {
  x: number;
  y: number;
  scale: number;
  opacity: number;
  crop: { x: number; y: number; w: number; h: number };
  axis: Axis;
  srcW: number;
  srcH: number;
}

function transformOf(clip: Clip): ClipTransform {
  return clip.transform ?? defaultTransform();
}

/** Evaluate a clip's pose at timeline time t (keyframes override statics). When
 *  `out` is supplied the result is written into it (zero-alloc, mirroring the
 *  scheduler's SCRATCH transform) instead of allocating a fresh pose; callers
 *  that keep the pose past the current frame (gesture snapshots) must NOT pass a
 *  shared scratch. */
function resolvePose(
  clip: Clip,
  media: MediaRef,
  project: { width: number; height: number },
  t: number,
  out?: ResolvedPose,
): ResolvedPose {
  const tr = transformOf(clip);
  const srcW = Math.max(1, media.width ?? project.width);
  const srcH = Math.max(1, media.height ?? project.height);
  const kfs = clip.keyframes;
  let x = tr.x;
  let y = tr.y;
  let scale = tr.scale;
  let opacity = tr.opacity;
  if (kfs) {
    const s = sourceTime(clip, t - clip.timelineStart);
    if (kfs.x) x = evalKfs(kfs.x, s);
    if (kfs.y) y = evalKfs(kfs.y, s);
    if (kfs.scale) scale = evalKfs(kfs.scale, s);
    if (kfs.opacity) opacity = evalKfs(kfs.opacity, s);
  }
  const p = out ?? ({ crop: { x: 0, y: 0, w: 0, h: 0 }, axis: { rotate: 0, flipH: false, flipV: false } } as ResolvedPose);
  p.x = x; p.y = y; p.scale = scale; p.opacity = opacity;
  p.srcW = srcW; p.srcH = srcH;
  if (tr.crop) {
    p.crop.x = tr.crop.x; p.crop.y = tr.crop.y; p.crop.w = tr.crop.w; p.crop.h = tr.crop.h;
  } else {
    p.crop.x = 0; p.crop.y = 0; p.crop.w = srcW; p.crop.h = srcH;
  }
  p.axis.rotate = tr.rotate; p.axis.flipH = tr.flipH; p.axis.flipV = tr.flipV;
  return p;
}

// One scratch pose reused by the per-tick render() (mirrors scheduler.ts SCRATCH);
// never escapes the render() frame, so gesture snapshots keep allocating fresh.
const RENDER_POSE: ResolvedPose = {
  x: 0, y: 0, scale: 1, opacity: 1,
  crop: { x: 0, y: 0, w: 0, h: 0 },
  axis: { rotate: 0, flipH: false, flipV: false },
  srcW: 1, srcH: 1,
};
// Scratch PoseState fed into displayRect() so poseRect() allocates no input
// literal on the hot path; its crop is re-pointed at the pose's crop each call.
const POSE_IN: PoseState = { crop: RENDER_POSE.crop, scale: 1, x: 0, y: 0 };

/** The axis-aligned display rect of a resolved pose, in project px. `into`, when
 *  given, is the PoseState scratch fed to displayRect (avoids the input literal);
 *  displayRect still returns a fresh rect (canvas-math, out of our control). */
function poseRect(
  pose: ResolvedPose,
  project: { width: number; height: number },
  into?: PoseState,
): { cx: number; cy: number; w: number; h: number } {
  let src: PoseState;
  if (into) {
    into.crop = pose.crop; into.scale = pose.scale; into.x = pose.x; into.y = pose.y;
    src = into;
  } else {
    src = { crop: pose.crop, scale: pose.scale, x: pose.x, y: pose.y };
  }
  return displayRect(
    src,
    pose.srcW,
    pose.srcH,
    project.width,
    project.height,
    pose.axis.rotate,
  );
}

/* ------------------------------------------------------------------ */
/* DOM construction                                                     */
/* ------------------------------------------------------------------ */

interface Chrome {
  overlay: HTMLElement;
  // selection
  selBox: HTMLElement;
  selHandles: Record<string, HTMLElement>;
  // crop
  veil: HTMLElement;
  ghost: HTMLElement;
  ghostMedia: HTMLElement | null; // set on crop enter, cleared on exit
  window: HTMLElement;
  windowHandles: Record<WindowHandle, HTMLElement>;
  // center-snap guides (vertical + horizontal), toggled during a move drag
  guideV: HTMLElement;
  guideH: HTMLElement;
}

function buildChrome(host: HTMLElement): Chrome {
  const overlay = document.createElement("div");
  overlay.className = "stage-overlay";
  overlay.tabIndex = 0;

  const selBox = document.createElement("div");
  selBox.className = "stage-overlay__selbox";
  const selHandles: Record<string, HTMLElement> = {};
  for (const h of CORNER_HANDLES) {
    const el = document.createElement("div");
    el.className = `stage-overlay__handle stage-overlay__handle--${h}`;
    el.dataset.handle = h;
    selBox.appendChild(el);
    selHandles[h] = el;
  }

  const veil = document.createElement("div");
  veil.className = "stage-overlay__veil";

  const ghost = document.createElement("div");
  ghost.className = "stage-overlay__ghost crop-ghost";

  const win = document.createElement("div");
  win.className = "stage-overlay__window";
  const windowHandles = {} as Record<WindowHandle, HTMLElement>;
  for (const h of ALL_HANDLES) {
    const el = document.createElement("div");
    el.className = `stage-overlay__handle stage-overlay__handle--${h}`;
    el.dataset.crophandle = h;
    win.appendChild(el);
    windowHandles[h] = el;
  }

  const guideV = document.createElement("div");
  guideV.className = "stage-overlay__guide stage-overlay__guide--v";
  const guideH = document.createElement("div");
  guideH.className = "stage-overlay__guide stage-overlay__guide--h";

  // z-order inside the overlay: veil < ghost < window < selbox < guides
  overlay.append(veil, ghost, win, selBox, guideV, guideH);
  host.appendChild(overlay);

  return {
    overlay, selBox, selHandles, veil, ghost, ghostMedia: null, window: win, windowHandles,
    guideV, guideH,
  };
}

/* ------------------------------------------------------------------ */
/* Mount                                                                */
/* ------------------------------------------------------------------ */

export function mountCanvasOverlay(ctx: OverlayCtx): { dispose(): void } {
  const { stage, scheduler, engine, session, selection } = ctx;
  const chrome = buildChrome(stage.canvas);
  const { overlay } = chrome;

  let mode: "idle" | "crop" = "idle";
  let cropClipId: string | null = null;

  // cached style state for cheap dirty-checking (avoid style writes when nothing
  // moved). Keyed by a compact string signature per element group.
  let lastSelSig = "";
  let lastCropSig = "";

  // Recompute gate for the selection branch: skip selectedVisible()/resolvePose()/
  // poseRect() entirely when nothing that can change the box changed. Key inputs:
  // playhead time, selected id, stage scale, and the project REFERENCE (every
  // mutation — edit, replace, undo, redo — swaps it via store.set, so this covers
  // a same-time pose change like undo of a transform edit). During keyframed
  // playback engine.time advances every frame so the key busts every frame (by
  // design). `keyed` guards the first call (all-null key is a legal state).
  let keyed = false;
  let kTime = 0;
  let kSelId: string | null = null;
  let kScale = 0;
  let kProject: ProjectFile | null = null;

  function invalidateRenderKey(): void {
    keyed = false;
  }

  /* ---------------- geometry helpers ---------------- */

  const project = (): { width: number; height: number } => session.project.timeline;
  const S = (): number => stage.scale;

  /** Selected clip that is actually visible at the playhead, with its media. */
  function selectedVisible(): { clip: Clip; media: MediaRef } | null {
    const id = selection.get();
    if (!id) return null;
    const vis = scheduler.visibleClipsAt(engine.time);
    for (const v of vis) if (v.clip.id === id) return { clip: v.clip, media: v.media };
    return null;
  }

  /** Convert a client (px) point to project-canvas px. */
  function clientToProject(clientX: number, clientY: number): { x: number; y: number } {
    const box = stage.canvas.getBoundingClientRect();
    return { x: (clientX - box.left) / S(), y: (clientY - box.top) / S() };
  }

  /* ---------------- center-snap guides ---------------- */

  // last shown state, so pointermove only writes display when it actually flips.
  let guideVShown = false;
  let guideHShown = false;

  function showGuides(v: boolean, h: boolean): void {
    if (v !== guideVShown) {
      chrome.guideV.style.display = v ? "block" : "none";
      guideVShown = v;
    }
    if (h !== guideHShown) {
      chrome.guideH.style.display = h ? "block" : "none";
      guideHShown = h;
    }
  }

  function hideGuides(): void {
    showGuides(false, false);
  }

  /* ---------------- rendering (per tick + on change) ---------------- */

  function render(): void {
    if (mode === "crop") {
      renderCrop();
      return;
    }
    // Recompute gate: bail before any allocation/compute when the key inputs are
    // unchanged. The box's shown/hidden state and geometry are a pure function of
    // these four inputs, so an unchanged key means an identical frame.
    const time = engine.time;
    const selId = selection.get();
    const s = S();
    const proj = session.project;
    if (keyed && time === kTime && selId === kSelId && s === kScale && proj === kProject) return;
    keyed = true;
    kTime = time; kSelId = selId; kScale = s; kProject = proj;

    const sel = selectedVisible();
    if (!sel) {
      if (lastSelSig !== "") {
        chrome.selBox.style.display = "none";
        lastSelSig = "";
      }
      return;
    }
    const pose = resolvePose(sel.clip, sel.media, project(), engine.time, RENDER_POSE);
    const r = poseRect(pose, project(), POSE_IN);
    const sig = `${r.cx}|${r.cy}|${r.w}|${r.h}|${s}`;
    if (sig === lastSelSig) return;
    lastSelSig = sig;
    const left = (r.cx - r.w / 2) * s;
    const top = (r.cy - r.h / 2) * s;
    chrome.selBox.style.display = "block";
    chrome.selBox.style.left = `${left}px`;
    chrome.selBox.style.top = `${top}px`;
    chrome.selBox.style.width = `${r.w * s}px`;
    chrome.selBox.style.height = `${r.h * s}px`;
  }

  function renderCrop(): void {
    if (!cropClipId) return;
    const found = findClip(session.project, cropClipId);
    if (!found) {
      exitCrop();
      return;
    }
    const media = session.project.media.find((m) => m.id === found.clip.mediaId);
    if (!media) {
      exitCrop();
      return;
    }
    // crop mode pauses playback, so engine.time is fixed; still recompute in case
    // the stage refit changed scale.
    const pose = resolvePose(found.clip, media, project(), engine.time);
    const s = S();
    const proj = project();
    // window rect (the crop region on screen)
    const win = displayRect(
      { crop: pose.crop, scale: pose.scale, x: pose.x, y: pose.y },
      pose.srcW, pose.srcH, proj.width, proj.height, pose.axis.rotate,
    );
    const k = fit(pose.crop.w, pose.crop.h, pose.axis.rotate, proj.width, proj.height) * pose.scale;
    // ghost rect: full frame at the same k, centered so the crop offset matches.
    const m = axisMatrix(pose.axis);
    const winCx = win.cx;
    const winCy = win.cy;
    const offx = pose.srcW / 2 - (pose.crop.x + pose.crop.w / 2);
    const offy = pose.srcH / 2 - (pose.crop.y + pose.crop.h / 2);
    const ghostCx = winCx + (m.a * offx + m.b * offy) * k;
    const ghostCy = winCy + (m.c * offx + m.d * offy) * k;
    const rotated = pose.axis.rotate === 90 || pose.axis.rotate === 270;
    const ghostW = (rotated ? pose.srcH : pose.srcW) * k;
    const ghostH = (rotated ? pose.srcW : pose.srcH) * k;

    const sig = `${win.cx}|${win.cy}|${win.w}|${win.h}|${ghostCx}|${ghostCy}|${ghostW}|${ghostH}|${s}`;
    if (sig === lastCropSig) return;
    lastCropSig = sig;

    place(chrome.window, win.cx, win.cy, win.w, win.h, s);
    place(chrome.ghost, ghostCx, ghostCy, ghostW, ghostH, s);
    // veil covers the whole overlay; the window "hole" is faked with a box-shadow
    // on the window element (see CSS). Nothing to size on the veil.
  }

  function place(el: HTMLElement, cx: number, cy: number, w: number, h: number, s: number): void {
    el.style.left = `${(cx - w / 2) * s}px`;
    el.style.top = `${(cy - h / 2) * s}px`;
    el.style.width = `${w * s}px`;
    el.style.height = `${h * s}px`;
  }

  /* ---------------- selection + drag + scale ---------------- */

  function hitTest(px: number, py: number): string | null {
    const proj = project();
    for (const v of scheduler.visibleClipsAt(engine.time)) {
      const pose = resolvePose(v.clip, v.media, proj, engine.time);
      const r = poseRect(pose, proj);
      if (
        px >= r.cx - r.w / 2 && px <= r.cx + r.w / 2 &&
        py >= r.cy - r.h / 2 && py <= r.cy + r.h / 2
      ) {
        return v.clip.id;
      }
    }
    return null;
  }

  // active pointer gesture (drag or scale)
  interface Gesture {
    kind: "move" | "scale";
    clipId: string;
    before: ProjectFile;
    startProj: { x: number; y: number };
    startPose: ResolvedPose;
    // Keyframe source time frozen at gesture start. Reused for every auto-key
    // upsert during the gesture so a moving playhead (engine playing) edits one
    // keyframe instead of scattering a new one per pointermove.
    keySrcTime: number;
    // scale
    downDist?: number;
    centerProj?: { x: number; y: number };
  }
  let gesture: Gesture | null = null;

  function onPointerDown(e: PointerEvent): void {
    if (mode === "crop") return onCropPointerDown(e);
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const handle = target.dataset.handle as WindowHandle | undefined;
    const sel = selectedVisible();

    // corner-handle scale
    if (handle && sel && CORNER_HANDLES.includes(handle)) {
      const proj = project();
      const pose = resolvePose(sel.clip, sel.media, proj, engine.time);
      const r = poseRect(pose, proj);
      const center = { x: r.cx, y: r.cy };
      const p = clientToProject(e.clientX, e.clientY);
      gesture = {
        kind: "scale",
        clipId: sel.clip.id,
        before: session.project,
        startProj: p,
        startPose: pose,
        keySrcTime: sourceTime(sel.clip, engine.time - sel.clip.timelineStart),
        downDist: Math.hypot(p.x - center.x, p.y - center.y),
        centerProj: center,
      };
      capture(overlay, e.pointerId);
      e.preventDefault();
      return;
    }

    // hit-test for selection / move
    const p = clientToProject(e.clientX, e.clientY);
    const hit = hitTest(p.x, p.y);
    if (hit !== selection.get()) selection.set(hit);
    if (!hit) return;
    const found = findClip(session.project, hit);
    const media = found && session.project.media.find((mm) => mm.id === found.clip.mediaId);
    if (!found || !media) return;
    const pose = resolvePose(found.clip, media, project(), engine.time);
    gesture = {
      kind: "move",
      clipId: hit,
      before: session.project,
      startProj: p,
      startPose: pose,
      keySrcTime: sourceTime(found.clip, engine.time - found.clip.timelineStart),
    };
    capture(overlay, e.pointerId);
    // do NOT preventDefault: dblclick needs the native pointer sequence
  }

  function onPointerMove(e: PointerEvent): void {
    if (mode === "crop") return onCropPointerMove(e);
    if (!gesture) return;
    const p = clientToProject(e.clientX, e.clientY);
    if (gesture.kind === "move") {
      const dx = p.x - gesture.startProj.x;
      const dy = p.y - gesture.startProj.y;
      let nx = gesture.startPose.x + dx;
      let ny = gesture.startPose.y + dy;
      // Snap the clip center to the project center (0,0), each axis independent.
      // x/y are already center-relative offsets, so snapping toward 0 IS snapping
      // to the canvas center. Zero cost when disabled: no compute, guides stay off.
      if (settingsStore.get().snapCenterGuides) {
        const threshold = SNAP_SCREEN_PX / S();
        const snap = snapToCenter(nx, ny, threshold);
        nx = snap.x;
        ny = snap.y;
        showGuides(snap.snappedX, snap.snappedY);
      }
      applyPosition(gesture.clipId, nx, ny, gesture.keySrcTime);
    } else {
      const center = gesture.centerProj!;
      const dist = Math.hypot(p.x - center.x, p.y - center.y);
      const ratio = gesture.downDist! > 1e-3 ? dist / gesture.downDist! : 1;
      const nextScale = clamp(gesture.startPose.scale * ratio, SCALE_MIN, SCALE_MAX);
      applyScale(gesture.clipId, gesture.startPose.scale, nextScale, gesture.keySrcTime);
    }
  }

  function onPointerUp(e: PointerEvent): void {
    if (mode === "crop") return onCropPointerUp(e);
    if (!gesture) return;
    const g = gesture;
    gesture = null;
    hideGuides(); // drag over → drop the center-snap guides
    try { overlay.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    session.commitFrom(g.before);
  }

  /** Auto-key or static position write, then live-replace (no history). The
   *  keyframe source time is frozen at gesture start (keySrcTime) so a moving
   *  playhead edits one keyframe instead of scattering one per pointermove. */
  function applyPosition(clipId: string, x: number, y: number, keySrcTime: number): void {
    const found = findClip(session.project, clipId);
    if (!found) return;
    const clip = found.clip;
    const hasPosKf = !!(clip.keyframes?.x || clip.keyframes?.y);
    let next: ProjectFile;
    if (hasPosKf) {
      next = setPositionKeyframes(session.project, clipId, keySrcTime, x, y);
    } else {
      const tr = transformOf(clip);
      next = updateClip(session.project, clipId, { transform: { ...tr, x, y } });
    }
    session.replace(next);
    ctx.refresh();
  }

  /** Auto-key or static scale write. When the clip has scale keyframes we upsert
   *  at the gesture-start source time (keySrcTime, frozen so a moving playhead
   *  edits one keyframe); otherwise edit the static scale. */
  function applyScale(clipId: string, _startScale: number, scale: number, keySrcTime: number): void {
    const found = findClip(session.project, clipId);
    if (!found) return;
    const clip = found.clip;
    const hasScaleKf = !!clip.keyframes?.scale;
    let next: ProjectFile;
    if (hasScaleKf) {
      next = setKeyframe(session.project, clipId, "scale", keySrcTime, scale);
    } else {
      const tr = transformOf(clip);
      next = updateClip(session.project, clipId, { transform: { ...tr, scale } });
    }
    session.replace(next);
    ctx.refresh();
  }

  /* ---------------- keyboard ---------------- */

  let nudgeBefore: ProjectFile | null = null;
  let nudgeIdle: number | undefined;
  // Keyframe source time frozen when a nudge run begins; reused for every upsert
  // in the run so a moving playhead edits one keyframe (mirrors the drag gesture).
  let nudgeSrcTime = 0;

  function commitNudge(): void {
    if (nudgeBefore) {
      session.commitFrom(nudgeBefore);
      nudgeBefore = null;
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (mode === "crop") {
      // crop mode is modal: swallow ALL keys so the global shortcuts (Space =
      // play, S = split, arrows = frame step, etc.) don't fire while crop mode
      // owns the focused overlay. Escape exits crop first.
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") exitCrop();
      return;
    }
    if (e.key === "Escape") {
      if (selection.get()) { e.preventDefault(); e.stopPropagation(); selection.set(null); }
      return;
    }
    const arrow =
      e.key === "ArrowLeft" ? [-1, 0] :
      e.key === "ArrowRight" ? [1, 0] :
      e.key === "ArrowUp" ? [0, -1] :
      e.key === "ArrowDown" ? [0, 1] : null;
    if (!arrow) return;
    const sel = selectedVisible();
    if (!sel) return;
    // nudge instead of the global frame-step shortcut
    e.preventDefault();
    e.stopPropagation();
    const step = e.shiftKey ? 10 : 1;
    if (!nudgeBefore) {
      nudgeBefore = session.project;
      nudgeSrcTime = sourceTime(sel.clip, engine.time - sel.clip.timelineStart);
    }
    const pose = resolvePose(sel.clip, sel.media, project(), engine.time);
    applyPosition(sel.clip.id, pose.x + arrow[0]! * step, pose.y + arrow[1]! * step, nudgeSrcTime);
    window.clearTimeout(nudgeIdle);
    nudgeIdle = window.setTimeout(commitNudge, 400);
  }

  function onKeyUp(e: KeyboardEvent): void {
    if (e.key.startsWith("Arrow")) commitNudge();
  }

  /* ---------------- crop mode ---------------- */

  function onDblClick(e: PointerEvent | MouseEvent): void {
    if (mode === "crop") { exitCrop(); return; }
    const p = clientToProject(e.clientX, e.clientY);
    const hit = hitTest(p.x, p.y);
    if (!hit) return;
    if (selection.get() !== hit) selection.set(hit);
    enterCrop(hit);
  }

  function enterCrop(clipId: string): void {
    const found = findClip(session.project, clipId);
    if (!found) return;
    const media = session.project.media.find((mm) => mm.id === found.clip.mediaId);
    if (!media) return;
    engine.pause();
    mode = "crop";
    cropClipId = clipId;
    lastCropSig = "";
    lastSelSig = "";
    hideGuides(); // never leave a snap guide up when crop chrome takes over
    chrome.selBox.style.display = "none";
    chrome.veil.style.display = "block";
    chrome.ghost.style.display = "block";
    chrome.window.style.display = "block";
    buildGhostMedia(found.clip, media);
    render();
  }

  function exitCrop(): void {
    if (mode !== "crop") return;
    mode = "idle";
    cropClipId = null;
    lastCropSig = "";
    lastSelSig = "";
    invalidateRenderKey(); // mode isn't in the key; force the idle path to recompute
    chrome.veil.style.display = "none";
    chrome.ghost.style.display = "none";
    chrome.window.style.display = "none";
    destroyGhostMedia();
    render();
  }

  /** Ghost media: a transient decoder (video) or cloned node (image/gen) showing
   *  the FULL uncropped frame, filling the ghost box. Only alive during crop. */
  function buildGhostMedia(clip: Clip, media: MediaRef): void {
    destroyGhostMedia();
    let el: HTMLElement;
    if (media.generator) {
      // clone the live gen div for this layer if present, else an empty box
      el = document.createElement("div");
      el.style.width = "100%";
      el.style.height = "100%";
      if (media.generator.type === "solid") {
        el.style.background = media.generator.color;
      } else {
        const g = media.generator;
        el.style.color = g.color;
        el.style.whiteSpace = "pre";
        el.style.lineHeight = "1.25";
        el.style.display = "flex";
        el.style.alignItems = "center";
        el.style.justifyContent = "center";
        const style = g.italic ? "italic" : "normal";
        const weight = g.bold ? "bold" : "normal";
        el.style.font = `${style} ${weight} ${g.sizePx}px ${g.fontFamily}`;
        el.textContent = g.text;
      }
    } else if (media.kind === "image") {
      const img = document.createElement("img");
      img.src = mediaUrl(media.path);
      img.style.width = "100%";
      img.style.height = "100%";
      img.draggable = false;
      el = img;
    } else {
      // video: one transient extra decoder, seeked to the current source time.
      // Uses the original file URL (a paused ghost frame doesn't need the proxy).
      const v = document.createElement("video");
      v.src = mediaUrl(media.path);
      v.muted = true;
      v.playsInline = true;
      v.preload = "auto";
      v.style.width = "100%";
      v.style.height = "100%";
      const srcT = sourceTime(clip, engine.time - clip.timelineStart);
      const seek = (): void => { try { v.currentTime = srcT; } catch { /* not seekable yet */ } };
      if (v.readyState >= 1) seek();
      else v.addEventListener("loadedmetadata", seek, { once: true });
      el = v;
    }
    el.className = "stage-overlay__ghost-media";
    chrome.ghost.appendChild(el);
    chrome.ghostMedia = el;
  }

  function destroyGhostMedia(): void {
    if (chrome.ghostMedia) {
      if (chrome.ghostMedia instanceof HTMLVideoElement) chrome.ghostMedia.src = "";
      chrome.ghostMedia.remove();
      chrome.ghostMedia = null;
    }
  }

  // crop gesture
  interface CropGesture {
    kind: "window" | "ghostpan" | "ghostzoom";
    handle?: WindowHandle;
    before: ProjectFile;
    startPose: PoseState;
    startClient: { x: number; y: number };
    k: number;
    axis: Axis;
    srcW: number;
    srcH: number;
    ghostDiag?: number; // start diagonal for zoom
    ghostCenterClient?: { x: number; y: number };
    /** gesture-start scale keyframes (frozen) + the effective scale at t, so a
     *  multi-move scale-keyframed crop scales from the original values, not from
     *  values already mutated earlier in the same gesture. */
    startScaleKfs: { t: number; v: number }[] | null;
    startEffScale: number;
  }
  let cropGesture: CropGesture | null = null;

  function cropContext(): {
    pose: PoseState; axis: Axis; srcW: number; srcH: number; k: number;
    startScaleKfs: { t: number; v: number }[] | null; startEffScale: number;
  } | null {
    if (!cropClipId) return null;
    const found = findClip(session.project, cropClipId);
    if (!found) return null;
    const media = session.project.media.find((mm) => mm.id === found.clip.mediaId);
    if (!media) return null;
    const rp = resolvePose(found.clip, media, project(), engine.time);
    const proj = project();
    const k = fit(rp.crop.w, rp.crop.h, rp.axis.rotate, proj.width, proj.height) * rp.scale;
    const scaleKfs = found.clip.keyframes?.scale ?? null;
    return {
      pose: { crop: rp.crop, scale: rp.scale, x: rp.x, y: rp.y },
      axis: rp.axis, srcW: rp.srcW, srcH: rp.srcH, k,
      startScaleKfs: scaleKfs ? scaleKfs.map((k2) => ({ t: k2.t, v: k2.v })) : null,
      startEffScale: rp.scale,
    };
  }

  function onCropPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const cropHandle = target.dataset.crophandle as WindowHandle | undefined;
    const cc = cropContext();
    if (!cc) return;

    // 1) window handle → re-crop (crop the frame, ghost pinned).
    if (cropHandle) {
      cropGesture = {
        kind: "window",
        handle: cropHandle,
        before: session.project,
        startPose: cc.pose,
        startClient: { x: e.clientX, y: e.clientY },
        k: cc.k, axis: cc.axis, srcW: cc.srcW, srcH: cc.srcH,
        startScaleKfs: cc.startScaleKfs, startEffScale: cc.startEffScale,
      };
      capture(overlay, e.pointerId);
      e.preventDefault();
      return;
    }

    // Decide the rest by geometry (the window's box-shadow dims the area but
    // isn't a hit target, and the window sits above the ghost — so e.target
    // identity is unreliable; use bounding rects).
    const wbox = chrome.window.getBoundingClientRect();
    const gbox = chrome.ghost.getBoundingClientRect();
    const inside = (b: DOMRect): boolean =>
      e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top && e.clientY <= b.bottom;

    // 2) inside the window (but not a handle) → no-op (keeps the crop steady).
    if (inside(wbox)) {
      e.preventDefault();
      return;
    }

    // 3) over the ghost (outside the window) → pan or zoom the source.
    if (inside(gbox)) {
      const gcx = gbox.left + gbox.width / 2;
      const gcy = gbox.top + gbox.height / 2;
      const diag = Math.hypot(e.clientX - gcx, e.clientY - gcy);
      const nearCorner = isNearGhostCorner(e.clientX, e.clientY, gbox);
      cropGesture = {
        kind: nearCorner ? "ghostzoom" : "ghostpan",
        before: session.project,
        startPose: cc.pose,
        startClient: { x: e.clientX, y: e.clientY },
        k: cc.k, axis: cc.axis, srcW: cc.srcW, srcH: cc.srcH,
        ghostDiag: diag,
        ghostCenterClient: { x: gcx, y: gcy },
        startScaleKfs: cc.startScaleKfs, startEffScale: cc.startEffScale,
      };
      capture(overlay, e.pointerId);
      e.preventDefault();
      return;
    }

    // 4) click outside the ghost entirely → exit crop mode.
    exitCrop();
  }

  function isNearGhostCorner(cx: number, cy: number, box: DOMRect): boolean {
    const margin = Math.min(28, box.width / 4, box.height / 4);
    const nearX = cx - box.left < margin || box.right - cx < margin;
    const nearY = cy - box.top < margin || box.bottom - cy < margin;
    return nearX && nearY;
  }

  function onCropPointerMove(e: PointerEvent): void {
    if (!cropGesture) return;
    const g = cropGesture;
    const s = S();
    const screenDelta = {
      x: (e.clientX - g.startClient.x) / s,
      y: (e.clientY - g.startClient.y) / s,
    };
    let next: PoseState;
    if (g.kind === "window") {
      next = windowHandleDrag(
        g.startPose, g.srcW, g.srcH, project().width, project().height,
        g.axis, screenDelta, g.handle!, g.k,
      );
    } else if (g.kind === "ghostpan") {
      next = ghostDrag(g.startPose, g.srcW, g.srcH, g.axis, screenDelta, g.k);
    } else {
      // zoom factor from the ghost diagonal
      const gcx = g.ghostCenterClient!.x;
      const gcy = g.ghostCenterClient!.y;
      const nowDiag = Math.hypot(e.clientX - gcx, e.clientY - gcy);
      const factor = g.ghostDiag! > 1 ? nowDiag / g.ghostDiag! : 1;
      next = ghostResize(
        g.startPose, g.srcW, g.srcH, project().width, project().height, g.axis, factor, g.k,
      );
    }
    writeCropPose(cropClipId!, next, g);
  }

  function onCropPointerUp(e: PointerEvent): void {
    if (!cropGesture) return;
    const g = cropGesture;
    cropGesture = null;
    try { overlay.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    session.commitFrom(g.before);
  }

  /** Apply a new crop pose (crop + scale + x/y). When the clip has SCALE
   *  keyframes, multiply every scale keyframe value by scale'/scale (relative to
   *  the FROZEN gesture-start values, so multi-move gestures don't compound) and
   *  write transform+keyframes atomically (per plan). Otherwise write the static
   *  transform. Position/crop are always static fields on the transform. */
  function writeCropPose(clipId: string, pose: PoseState, g: CropGesture): void {
    const found = findClip(session.project, clipId);
    if (!found) return;
    const clip = found.clip;
    const tr = transformOf(clip);
    const crop = clampCrop(pose.crop, media_srcW(clip), media_srcH(clip));

    let next: ProjectFile;
    if (g.startScaleKfs && g.startEffScale > 1e-6) {
      const factor = pose.scale / g.startEffScale;
      const scaledKfs = g.startScaleKfs.map((k) => ({ t: k.t, v: k.v * factor }));
      next = updateClip(session.project, clipId, (c) => ({
        ...c,
        transform: { ...tr, crop, x: pose.x, y: pose.y },
        keyframes: { ...c.keyframes, scale: scaledKfs },
      }));
    } else {
      next = updateClip(session.project, clipId, {
        transform: { ...tr, crop, x: pose.x, y: pose.y, scale: pose.scale },
      });
    }
    session.replace(next);
    ctx.refresh();
  }

  function media_srcW(clip: Clip): number {
    const m = session.project.media.find((mm) => mm.id === clip.mediaId);
    return Math.max(1, m?.width ?? project().width);
  }
  function media_srcH(clip: Clip): number {
    const m = session.project.media.find((mm) => mm.id === clip.mediaId);
    return Math.max(1, m?.height ?? project().height);
  }

  /* ---------------- wiring ---------------- */

  overlay.addEventListener("pointerdown", onPointerDown);
  overlay.addEventListener("pointermove", onPointerMove);
  overlay.addEventListener("pointerup", onPointerUp);
  overlay.addEventListener("pointercancel", onPointerUp);
  overlay.addEventListener("dblclick", onDblClick);
  overlay.addEventListener("keydown", onKeyDown);
  overlay.addEventListener("keyup", onKeyUp);
  // focus on interaction so Esc/arrows work
  overlay.addEventListener("pointerdown", () => overlay.focus());

  const unTick = engine.onTick(() => render());
  const unSel = selection.subscribe(() => {
    // selection change exits crop mode (plan) and repositions the box
    if (mode === "crop" && selection.get() !== cropClipId) exitCrop();
    lastSelSig = "";
    render();
  });
  const unStore = session.store.subscribe(() => {
    lastSelSig = "";
    lastCropSig = "";
    render();
  });

  render();

  return {
    dispose(): void {
      window.clearTimeout(nudgeIdle);
      unTick();
      unSel();
      unStore();
      destroyGhostMedia();
      overlay.remove();
    },
  };
}
