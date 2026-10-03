// Right-docked properties panel. Rebuilds when the selection changes (or the
// selected clip disappears) and edits the selected clip's video transform and
// audio settings. Sliders live-commit: continuous changes flow through
// session.replace() during a drag (no history), then a single history entry is
// pushed on release via session.commitFrom(before).
//
// Animatable groups (Position / Scale / Opacity) carry a diamond toggle: when a
// group is animated its controls show the EVALUATED value at the playhead and
// edits auto-key (setKeyframe / setPositionKeyframes at the playhead's source
// time) instead of writing the static transform. When nothing is selected the
// panel shows a Project-canvas editor instead of the empty state.

import "./inspector.css";
import { formatDuration, escapeHtml } from "../../core/format";
import { ipc } from "../../core/ipc";
import { EPS_KF, evalKfs } from "../../core/anim";
import {
  MAX_CANVAS,
  MIN_CANVAS,
  clearAnimation,
  defaultTransform,
  detachAudio,
  findClip,
  findMedia,
  fitFillScale,
  removeClipAudio,
  removeKeyframesNear,
  setClipSpeed,
  setKeyframe,
  setPositionKeyframes,
  setProjectCanvas,
  updateClip,
} from "../../core/project";
import type { ProjectSession } from "../../core/session";
import type { Store } from "../../core/store";
import { mediaDisplayName } from "../../core/media-name";
import { clipDuration, fpsValue, sourceTime } from "../../core/time";
import type {
  AnimProp,
  Clip,
  ClipKeyframes,
  ClipTransform,
  MediaRef,
  ProjectFile,
  Timeline,
} from "../../core/types";
import type { PlaybackEngine } from "../playback/engine";
import type { MediaManager } from "../media/media";
import { toast } from "../../ui/toast";
import { buildGeneratedSection } from "./generated";

export interface InspectorCtx {
  session: ProjectSession;
  media: MediaManager;
  engine: PlaybackEngine;
  selection: Store<string | null>;
  refresh(): void;
  /** True while the canvas overlay has a move, scale or crop drag live
   *  (`CanvasOverlay.gestureActive`). Each of its pointermoves replace()s the
   *  project, and the dragged clip is the selected one, so without this the
   *  panel would be torn down and rebuilt once per pointermove. While it reads
   *  true, store-driven rebuilds are skipped; the overlay's `onGestureEnd` then
   *  calls `overlayGestureEnded()` on the handle to catch up once.
   *
   *  Read ONLY from the store subscriber, never while mounting: the editor
   *  mounts this panel before the overlay exists, so the accessor closes over
   *  a binding that is not initialised yet during the first render. */
  overlayGestureActive?: () => boolean;
}

/** What `mountInspector` hands back. */
export interface InspectorHandle {
  /** The canvas overlay's drag ended (wire to `OverlayCtx.onGestureEnd`).
   *  Rebuilds once if a store-driven rebuild was skipped while it ran — a
   *  committed drag notifies no store subscriber on its way out, so without
   *  this the panel would keep showing the values from before the drag. */
  overlayGestureEnded(): void;
  dispose(): void;
}

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const ROTATIONS: (0 | 90 | 180 | 270)[] = [0, 90, 180, 270];

/** Canvas-size presets shown in the Project panel. */
const CANVAS_PRESETS: { label: string; w: number; h: number }[] = [
  { label: "1920 × 1080 (16:9)", w: 1920, h: 1080 },
  { label: "2560 × 1440 (16:9)", w: 2560, h: 1440 },
  { label: "3840 × 2160 (16:9)", w: 3840, h: 2160 },
  { label: "1080 × 1920 (9:16)", w: 1080, h: 1920 },
  { label: "1440 × 1080 (4:3)", w: 1440, h: 1080 },
  { label: "1080 × 1080 (1:1)", w: 1080, h: 1080 },
  { label: "2560 × 1080 (21:9)", w: 2560, h: 1080 },
];

type Group = "position" | "scale" | "opacity";

/** Located clip plus its media and whether it lives on the video track. */
interface Target {
  clip: Clip;
  media: MediaRef;
  onVideoTrack: boolean;
}

function resolve(p: ProjectFile, id: string | null): Target | null {
  if (!id) return null;
  const found = findClip(p, id);
  if (!found) return null;
  const media = findMedia(p, found.clip.mediaId);
  if (!media) return null;
  return { clip: found.clip, media, onVideoTrack: found.track.kind === "video" };
}

/** True if some clip on an audio track shares this clip's media and overlaps its
 *  source [srcIn, srcOut) range — i.e. a detached copy that would double-play. */
function audioCopyOverlaps(p: ProjectFile, t: Target): boolean {
  const { clip } = t;
  for (const track of p.timeline.tracks) {
    if (track.kind !== "audio") continue;
    for (const c of track.clips) {
      if (c.mediaId !== clip.mediaId) continue;
      if (c.srcIn < clip.srcOut && clip.srcIn < c.srcOut) return true;
    }
  }
  return false;
}

/* ---------------- keyframe helpers (pure) ---------------- */

const PROPS_OF_GROUP: Record<Group, AnimProp[]> = {
  position: ["x", "y"],
  scale: ["scale"],
  opacity: ["opacity"],
};

/** Source time at the playhead for this clip (may lie outside [srcIn,srcOut]). */
function playheadSource(clip: Clip, playhead: number): number {
  return sourceTime(clip, playhead - clip.timelineStart);
}

/** Is the playhead within the clip's timeline footprint? */
function playheadInClip(clip: Clip, playhead: number): boolean {
  return playhead >= clip.timelineStart - 1e-6 && playhead <= clip.timelineStart + clipDuration(clip) + 1e-6;
}

/** Does a group have any keyframes on the clip? */
function groupAnimated(kfs: ClipKeyframes | undefined, group: Group): boolean {
  if (!kfs) return false;
  for (const prop of PROPS_OF_GROUP[group]) {
    const arr = kfs[prop];
    if (arr && arr.length > 0) return true;
  }
  return false;
}

/** Toggle state for a group's diamond: none = not animated, here = a keyframe
 *  sits at the playhead source time, elsewhere = animated but no kf here. */
function diamondState(clip: Clip, group: Group, s: number): "none" | "here" | "elsewhere" {
  if (!groupAnimated(clip.keyframes, group)) return "none";
  for (const prop of PROPS_OF_GROUP[group]) {
    const arr = clip.keyframes![prop];
    if (arr && arr.some((k) => Math.abs(k.t - s) <= EPS_KF)) return "here";
  }
  return "elsewhere";
}

/** Evaluated value of a single prop at source time s (falls back to static). */
function evalProp(clip: Clip, prop: AnimProp, staticVal: number, s: number): number {
  const arr = clip.keyframes?.[prop];
  if (arr && arr.length > 0) return evalKfs(arr, s);
  return staticVal;
}

export function mountInspector(
  host: HTMLElement,
  ctx: InspectorCtx,
): InspectorHandle {
  host.classList.add("inspector");

  // While a slider drag is in flight we update numbers in place instead of
  // tearing down and rebuilding the DOM (which would kill the drag).
  let dragging = false;
  // Cleanup for listeners attached during the current build.
  let cleanup: (() => void)[] = [];
  // True while rebuild() blurs the field that had focus, so the commits that
  // blur sets off cannot start a second rebuild from inside the first.
  let blurring = false;
  // A store-driven rebuild was skipped because the canvas overlay was dragging.
  let overlayPending = false;
  // The timeline and media list the panel on screen was built from. Every
  // control reads only those two (plus the selection and the playhead, which
  // have their own triggers), so a store change that keeps both — autosave's
  // modifiedAt stamp, the export preset — has nothing new to show, and
  // rebuilding for it would throw away the field the user is in the middle of.
  // Cleared by the panel's own live edits, the one way its controls come to
  // show something other than what it was built from. (A notification it
  // skips changes nothing on screen, so the build still describes what is
  // shown; a later return to that same state has nothing to rebuild.)
  let builtTimeline: Timeline | null = null;
  let builtMedia: MediaRef[] | null = null;
  const invalidateBuilt = (): void => {
    builtTimeline = null;
    builtMedia = null;
  };
  // Normalize scans in flight, by clip id: the inputs the scan was asked about
  // (to tell whether its answer still applies) and the button now showing it
  // (a rebuild replaces the button, and the scan must re-enable the live one).
  const normalizing = new Map<
    string,
    { path: string; srcIn: number; srcOut: number; btn: HTMLButtonElement }
  >();
  let disposed = false;

  function clearBuild(): void {
    for (const c of cleanup) c();
    cleanup = [];
    // The controls that could have set `dragging` are about to be (or have just
    // been) thrown away, so nothing can still be mid-gesture. This is not
    // belt-and-braces: removing a FOCUSED element fires no blur/focusout, so a
    // selection change while a slider had focus — selection.subscribe rebuilds
    // unconditionally — used to strand the flag at true with no control left
    // that could ever clear it.
    dragging = false;
  }

  const playhead = (): number => ctx.engine.time;

  /* -------- small builders (return elements, wire live-commit) -------- */

  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    cls?: string,
    html?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (html !== undefined) node.innerHTML = html;
    return node;
  };

  function section(title: string): HTMLElement {
    const s = el("div", "insp-section");
    s.appendChild(el("div", "insp-section__title", escapeHtml(title)));
    return s;
  }

  /** A .field row with a label and a provided control. */
  function field(label: string, control: HTMLElement): HTMLElement {
    const f = el("div", "field insp-field");
    f.appendChild(el("label", undefined, escapeHtml(label)));
    f.appendChild(control);
    return f;
  }

  /** Options common to the live-commit input builders. `replaceMutation`, when
   *  present, overrides the default updateClip(patch) live path — used for
   *  keyframe auto-keying, keyed at `src`: the clip's source time at the
   *  playhead, resolved once per gesture (see keyGesture). `disabled` greys
   *  the control out (with a hint). */
  interface LiveOpts {
    patch: (v: number) => Partial<Clip>;
    replaceMutation?: (v: number, src: number) => (p: ProjectFile) => ProjectFile;
    disabled?: boolean;
    disabledHint?: string;
  }

  /** Where an auto-keying gesture writes its keyframe, decided when the
   *  gesture's first edit arrives. `src` is null when the playhead is off the
   *  clip (nothing may be keyed there); `stale` says the panel no longer
   *  describes the moment being edited and must rebuild when the gesture ends. */
  interface KeyGesture {
    src: number | null;
    stale: boolean;
  }

  /**
   * Resolve an auto-keying gesture's source time.
   *
   * The panel is built once and NOT rebuilt while playing (no per-frame DOM
   * churn) or while one of its controls is held, so a source time captured at
   * build is wrong by however far the playhead has travelled since — the key
   * used to land wherever the playhead had been when the panel was built.
   * Reading the playhead on every input instead would scatter one keyframe per
   * input event along a moving playhead. So: once per gesture, at its first
   * edit rather than on focus, so tabbing through the panel never stops
   * playback. Playback is paused first, so the frame on screen is the frame
   * being keyed and the playhead holds still for the rest of the gesture. The
   * caller has already set `dragging`, which keeps the pause's own tick from
   * rebuilding the control under the pointer.
   */
  function keyGesture(clipId: string): KeyGesture {
    const wasPlaying = ctx.engine.playing;
    if (wasPlaying) ctx.engine.pause();
    const cur = resolve(ctx.session.project, clipId);
    const ph = playhead();
    const src = cur && playheadInClip(cur.clip, ph) ? playheadSource(cur.clip, ph) : null;
    return { src, stale: wasPlaying || src === null };
  }

  /** Apply one live value. `src` is the gesture's key time (read by the
   *  auto-key path only). Returns false when nothing was written: an auto-key
   *  whose playhead is off the clip leaves the project untouched rather than
   *  drop a stray keyframe outside it. */
  function applyLive(clipId: string, v: number, opts: LiveOpts, src: number | null): boolean {
    if (opts.replaceMutation) {
      if (src === null) return false;
      ctx.session.replace(opts.replaceMutation(v, src)(ctx.session.project));
    } else {
      ctx.session.replace(updateClip(ctx.session.project, clipId, opts.patch(v)));
    }
    invalidateBuilt();
    ctx.refresh();
    return true;
  }

  /** Live-commit slider with a numeric twin: replace() on input, commitFrom() on
   *  release. Both the slider and the number reflect each other live. */
  function slider(
    clipId: string,
    opts: LiveOpts & {
      min: number;
      max: number;
      step: number;
      value: number;
      /** decimals shown in the number twin (keeps it compact) */
      decimals?: number;
      format: (v: number) => string;
    },
  ): HTMLElement {
    const wrap = el("div", "insp-slider");
    const input = el("input", "slider");
    input.type = "range";
    input.min = String(opts.min);
    input.max = String(opts.max);
    input.step = String(opts.step);
    input.value = String(opts.value);

    const num = el("input", "input insp-num insp-num--twin");
    num.type = "number";
    num.min = String(opts.min);
    num.max = String(opts.max);
    num.step = String(opts.step);
    const dec = opts.decimals ?? 2;
    const fmtNum = (v: number): string => {
      const r = Number(v.toFixed(dec));
      return String(r);
    };
    num.value = fmtNum(opts.value);

    const readout = el("div", "insp-slider__value mono", escapeHtml(opts.format(opts.value)));

    wrap.appendChild(input);
    wrap.appendChild(readout);
    wrap.appendChild(num);

    if (opts.disabled) {
      input.disabled = true;
      num.disabled = true;
      if (opts.disabledHint) {
        input.title = opts.disabledHint;
        num.title = opts.disabledHint;
      }
      return wrap;
    }

    const clampRange = (v: number): number => Math.min(Math.max(v, opts.min), opts.max);

    let before: ProjectFile | null = null;
    // The auto-key target of the gesture in flight; null until its first edit.
    let key: KeyGesture | null = null;
    // The value last written to the project — what every part of the control
    // shows once the gesture ends, whatever is left in the number field.
    let last = opts.value;
    const begin = (): void => {
      dragging = true;
      if (!before) before = ctx.session.project;
    };
    const apply = (v: number): void => {
      let src: number | null = null;
      if (opts.replaceMutation) {
        key ??= keyGesture(clipId);
        src = key.src;
      }
      if (applyLive(clipId, v, opts, src)) last = v;
    };
    const commit = (): void => {
      const gesture = key;
      key = null;
      if (before) {
        ctx.session.commitFrom(before);
        before = null;
      }
      dragging = false;
      // Settle all three views on the applied value: a typed 5 in a 0..1 field
      // applied 1, and an emptied field applied nothing at all.
      input.value = String(last);
      num.value = fmtNum(last);
      readout.textContent = opts.format(last);
      // Last, with the gesture fully closed: the rebuild blurs this control,
      // and the commit that blur runs must find nothing left to do.
      if (gesture?.stale && !blurring) rebuild();
    };
    const onSlider = (): void => {
      // begin() here, not only on focusin/pointerdown: a range input fires
      // input+change on EVERY arrow key, so the second and later keyboard
      // nudges arrive after commit() already cleared `before` — without this
      // they edit the project through replace() and land no history entry.
      begin();
      const v = clampRange(Number(input.value));
      num.value = fmtNum(v);
      readout.textContent = opts.format(v);
      apply(v);
    };
    const onNum = (): void => {
      // An emptied field reads "", and so does one holding only "-" or "1e"
      // (a number input's value is "" while its text is not a number) — and
      // Number("") is 0, which used to be applied live. Wait for a number.
      if (num.value === "") return;
      const raw = Number(num.value);
      if (!Number.isFinite(raw)) return;
      begin(); // same reason as onSlider
      const v = clampRange(raw);
      // Show the clamp at once when the value is over the top: more digits can
      // only make it larger, so this never fights the typing. Under the bottom
      // waits for the commit — "0" on its way to "0.5" is a prefix below a 0.1
      // minimum, and rewriting it would break the number mid-word.
      if (raw > opts.max) num.value = fmtNum(v);
      input.value = String(v);
      readout.textContent = opts.format(v);
      apply(v);
    };
    input.addEventListener("pointerdown", begin);
    input.addEventListener("focusin", begin);
    input.addEventListener("input", onSlider);
    input.addEventListener("change", commit);
    input.addEventListener("pointerup", commit);
    // Focus can leave the slider without a change event — Tab on, Tab off, no
    // value touched — and `dragging` gated every rebuild in the panel, so the
    // stranded flag froze the inspector against undo/redo, trims, deletion and
    // playhead scrubs until a plain click happened to heal it. `num` already
    // had its blur; the range input had nothing.
    input.addEventListener("focusout", commit);
    num.addEventListener("focusin", begin);
    num.addEventListener("input", onNum);
    num.addEventListener("change", commit);
    num.addEventListener("blur", commit);
    cleanup.push(() => {
      input.removeEventListener("pointerdown", begin);
      input.removeEventListener("focusin", begin);
      input.removeEventListener("input", onSlider);
      input.removeEventListener("change", commit);
      input.removeEventListener("pointerup", commit);
      input.removeEventListener("focusout", commit);
      num.removeEventListener("focusin", begin);
      num.removeEventListener("input", onNum);
      num.removeEventListener("change", commit);
      num.removeEventListener("blur", commit);
    });
    return wrap;
  }

  /** Live-commit number input with clamping; commits one history step on
   *  blur/enter. Supports the same keyframe auto-key override as slider(). */
  function numberInput(
    clipId: string,
    opts: LiveOpts & {
      value: number;
      step?: number;
      clamp: (v: number) => number;
      /** How a value is written into the field. The default trims float tails
       *  (0.30000000000000004 → 0.3) to at most three decimals. */
      format?: (v: number) => string;
    },
  ): HTMLInputElement {
    const input = el("input", "input insp-num");
    input.type = "number";
    if (opts.step !== undefined) input.step = String(opts.step);
    const fmt = opts.format ?? ((v: number): string => String(Number(v.toFixed(3))));
    input.value = fmt(opts.value);

    if (opts.disabled) {
      input.disabled = true;
      if (opts.disabledHint) input.title = opts.disabledHint;
      return input;
    }

    let before: ProjectFile | null = null;
    let key: KeyGesture | null = null; // as in slider()
    let last = opts.value; // as in slider()
    const begin = (): void => {
      dragging = true;
      if (!before) before = ctx.session.project;
    };
    const onInput = (): void => {
      // As in slider(): "" (empty, "-", "1e") must not apply Number("") = 0.
      if (input.value === "") return;
      const raw = Number(input.value);
      if (!Number.isFinite(raw)) return;
      begin(); // re-capture the baseline if a commit already consumed it
      const v = opts.clamp(raw);
      let src: number | null = null;
      if (opts.replaceMutation) {
        key ??= keyGesture(clipId);
        src = key.src;
      }
      if (applyLive(clipId, v, opts, src)) last = v;
    };
    const commit = (): void => {
      const gesture = key;
      key = null;
      // The field shows what the project holds: the clamped value that was
      // applied or, for a field left empty or invalid, the value it had
      // before — never a 0 that nothing applied.
      input.value = fmt(last);
      if (before) {
        ctx.session.commitFrom(before);
        before = null;
      }
      dragging = false;
      if (gesture?.stale && !blurring) rebuild(); // as in slider()
    };
    input.addEventListener("focusin", begin);
    input.addEventListener("input", onInput);
    input.addEventListener("change", commit);
    input.addEventListener("blur", commit);
    cleanup.push(() => {
      input.removeEventListener("focusin", begin);
      input.removeEventListener("input", onInput);
      input.removeEventListener("change", commit);
      input.removeEventListener("blur", commit);
    });
    return input;
  }

  function switchToggle(
    checked: boolean,
    onChange: (v: boolean) => void,
  ): HTMLInputElement {
    const input = el("input", "switch");
    input.type = "checkbox";
    input.checked = checked;
    const handler = (): void => onChange(input.checked);
    input.addEventListener("change", handler);
    cleanup.push(() => input.removeEventListener("change", handler));
    return input;
  }

  function button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
    const b = el("button", cls);
    b.textContent = label;
    b.addEventListener("click", onClick);
    cleanup.push(() => b.removeEventListener("click", onClick));
    return b;
  }

  /* -------- discrete commit helper -------- */

  const commit = (mutate: (p: ProjectFile) => ProjectFile): void => {
    ctx.session.commit(mutate);
    ctx.refresh();
  };

  /* -------- animated-group header (label + diamond toggle + clear) -------- */

  /** A group header row: the group label, a diamond toggle button, and a
   *  "Clear animation" ghost button (visible only when animated). */
  function groupHeader(t: Target, group: Group, label: string): HTMLElement {
    const s = playheadSource(t.clip, playhead());
    const inClip = playheadInClip(t.clip, playhead());
    const state = diamondState(t.clip, group, s);

    const row = el("div", "insp-grouphead");
    row.appendChild(el("div", "insp-sublabel", escapeHtml(label)));

    const controls = el("div", "insp-grouphead__ctrls");

    const diamond = el("button", `insp-kf insp-kf--${state}`);
    diamond.type = "button";
    diamond.innerHTML =
      '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">' +
      '<path d="M6 1 L11 6 L6 11 L1 6 Z" /></svg>';
    diamond.title =
      state === "none"
        ? "Animate (add first keyframe)"
        : state === "here"
          ? "Remove keyframe at playhead"
          : "Add keyframe at playhead";
    if (!inClip) {
      diamond.disabled = true;
      diamond.title = "Move the playhead over the clip to keyframe";
    }
    const onDiamond = (): void => toggleKeyframe(t, group);
    diamond.addEventListener("click", onDiamond);
    cleanup.push(() => diamond.removeEventListener("click", onDiamond));
    controls.appendChild(diamond);

    if (state !== "none") {
      const clear = button("Clear", "btn btn--ghost btn--xs insp-kf-clear", () =>
        clearGroupAnimation(t, group),
      );
      clear.title = "Clear this animation (bakes the current value)";
      controls.appendChild(clear);
    }

    row.appendChild(controls);
    return row;
  }

  /** The evaluated pose (x, y, scale, opacity) at the playhead source time. */
  function evalPose(clip: Clip, tf: ClipTransform, s: number): {
    x: number;
    y: number;
    scale: number;
    opacity: number;
  } {
    return {
      x: evalProp(clip, "x", tf.x, s),
      y: evalProp(clip, "y", tf.y, s),
      scale: evalProp(clip, "scale", tf.scale, s),
      opacity: evalProp(clip, "opacity", tf.opacity, s),
    };
  }

  /** Diamond click: seed / upsert / remove per the plan's rules. */
  function toggleKeyframe(t: Target, group: Group): void {
    const clipId = t.clip.id;
    const cur = resolve(ctx.session.project, clipId);
    if (!cur) return;
    const clip = cur.clip;
    const tf = clip.transform ?? defaultTransform();
    const ph = playhead();
    if (!playheadInClip(clip, ph)) return;
    const s = playheadSource(clip, ph);
    const state = diamondState(clip, group, s);
    const pose = evalPose(clip, tf, s);

    if (state === "here") {
      // Toggle OFF at an existing keyframe. If it's the LAST keyframe of the
      // group, bake the evaluated value first so nothing jumps.
      commit((p) => {
        const found = findClip(p, clipId);
        if (!found) return p;
        const c = found.clip;
        const count = PROPS_OF_GROUP[group].reduce(
          (n, prop) => Math.max(n, c.keyframes?.[prop]?.length ?? 0),
          0,
        );
        if (count <= 1) {
          const bake =
            group === "position"
              ? { x: pose.x, y: pose.y }
              : group === "scale"
                ? { scale: pose.scale }
                : { opacity: pose.opacity };
          return clearAnimation(p, clipId, group, bake);
        }
        return removeKeyframesNear(p, clipId, group, s);
      });
      return;
    }

    // Toggle ON (seed first kf from static value, or upsert current evaluated).
    commit((p) => {
      if (group === "position") {
        return setPositionKeyframes(p, clipId, s, pose.x, pose.y);
      }
      if (group === "scale") {
        return setKeyframe(p, clipId, "scale", s, pose.scale);
      }
      return setKeyframe(p, clipId, "opacity", s, pose.opacity);
    });
  }

  /** Fit / Fill / Center the selected clip in one history step. Scale (fit/fill)
   *  and position are written the SAME way the sliders do: an animated group is
   *  keyed at the playhead source time; a static group writes clip.transform. */
  function applyAutoFit(t: Target, mode: "fit" | "fill" | "center"): void {
    const clipId = t.clip.id;
    const cur = resolve(ctx.session.project, clipId);
    if (!cur) return;
    const clip = cur.clip;
    const tf = clip.transform ?? defaultTransform();
    const ph = playhead();
    const s = playheadSource(clip, ph);
    const inClip = playheadInClip(clip, ph);

    const touchScale = mode !== "center";
    const scaleAnimated = groupAnimated(clip.keyframes, "scale");
    const posAnimated = groupAnimated(clip.keyframes, "position");
    // Mirror the sliders' disabled rule: an animated group can only be edited
    // while the playhead sits over the clip (otherwise we'd drop a stray kf).
    if ((posAnimated && !inClip) || (touchScale && scaleAnimated && !inClip)) {
      toast.refuse("Move the playhead over the clip to edit its animation.");
      return;
    }

    const proj = ctx.session.project.timeline;
    const scale =
      mode === "center"
        ? tf.scale
        : fitFillScale(
            cur.media.width ?? proj.width,
            cur.media.height ?? proj.height,
            tf.crop,
            proj.width,
            proj.height,
            mode,
            tf.rotate,
          );

    commit((p) => {
      let next = p;
      // Position → (0, 0), centered.
      if (posAnimated) {
        next = setPositionKeyframes(next, clipId, s, 0, 0);
      } else {
        const c = resolve(next, clipId);
        const base = c?.clip.transform ?? defaultTransform();
        next = updateClip(next, clipId, { transform: { ...base, x: 0, y: 0 } });
      }
      // Scale (fit/fill only).
      if (touchScale) {
        if (scaleAnimated) {
          next = setKeyframe(next, clipId, "scale", s, scale);
        } else {
          const c = resolve(next, clipId);
          const base = c?.clip.transform ?? defaultTransform();
          next = updateClip(next, clipId, { transform: { ...base, scale } });
        }
      }
      return next;
    });
  }

  /** Clear a group's animation, baking the evaluated pose so nothing jumps. */
  function clearGroupAnimation(t: Target, group: Group): void {
    const clipId = t.clip.id;
    const cur = resolve(ctx.session.project, clipId);
    if (!cur) return;
    const clip = cur.clip;
    const tf = clip.transform ?? defaultTransform();
    const s = playheadSource(clip, playhead());
    const pose = evalPose(clip, tf, s);
    const bake =
      group === "position"
        ? { x: pose.x, y: pose.y }
        : group === "scale"
          ? { scale: pose.scale }
          : { opacity: pose.opacity };
    commit((p) => clearAnimation(p, clipId, group, bake));
  }

  /* -------- section builders -------- */

  function buildVideoSection(t: Target): HTMLElement {
    const s = section("Video");
    const clipId = t.clip.id;
    const tf = t.clip.transform ?? defaultTransform();
    const ph = playhead();
    const inClip = playheadInClip(t.clip, ph);
    const src = playheadSource(t.clip, ph);
    const hint = "Move the playhead over the clip to edit its animation.";

    // Speed
    const speedSel = el("select", "select select--sm");
    for (const sp of SPEEDS) {
      const o = el("option");
      o.value = String(sp);
      o.textContent = `${sp}×`;
      if (Math.abs(sp - t.clip.speed) < 1e-6) o.selected = true;
      speedSel.appendChild(o);
    }
    const onSpeed = (): void => {
      commit((p) => setClipSpeed(p, clipId, Number(speedSel.value)));
    };
    speedSel.addEventListener("change", onSpeed);
    cleanup.push(() => speedSel.removeEventListener("change", onSpeed));
    s.appendChild(field("Speed", speedSel));

    /* ---- Scale (animatable) ---- */
    const scaleAnimated = groupAnimated(t.clip.keyframes, "scale");
    const scaleVal = evalProp(t.clip, "scale", tf.scale, src);
    s.appendChild(groupHeader(t, "scale", "Scale"));
    s.appendChild(
      slider(clipId, {
        min: 0.1,
        max: 4,
        step: 0.01,
        value: scaleVal,
        format: (v) => `${v.toFixed(2)}×`,
        disabled: scaleAnimated && !inClip,
        disabledHint: hint,
        patch: (v) => ({ transform: { ...(currentTransform(clipId) ?? tf), scale: v } }),
        replaceMutation: scaleAnimated
          ? (v, keySrc) => (p) => setKeyframe(p, clipId, "scale", keySrc, v)
          : undefined,
      }),
    );

    /* ---- Position X / Y (animatable, paired) ---- */
    const posAnimated = groupAnimated(t.clip.keyframes, "position");
    const posX = evalProp(t.clip, "x", tf.x, src);
    const posY = evalProp(t.clip, "y", tf.y, src);
    s.appendChild(groupHeader(t, "position", "Position"));
    const posRow = el("div", "insp-row");
    // For paired auto-key, an edit to X keys BOTH x and the current y (and vice
    // versa) so the arrays stay paired.
    const posReplace =
      (axis: "x" | "y") =>
      (v: number, keySrc: number) =>
      (p: ProjectFile): ProjectFile => {
        const c = resolve(p, clipId);
        if (!c) return p;
        const t2 = c.clip.transform ?? defaultTransform();
        const curX = axis === "x" ? v : evalProp(c.clip, "x", t2.x, keySrc);
        const curY = axis === "y" ? v : evalProp(c.clip, "y", t2.y, keySrc);
        return setPositionKeyframes(p, clipId, keySrc, curX, curY);
      };
    posRow.appendChild(
      field(
        "X",
        numberInput(clipId, {
          value: posX,
          clamp: (v) => Math.round(v),
          format: (v) => String(Math.round(v)),
          disabled: posAnimated && !inClip,
          disabledHint: hint,
          patch: (v) => ({ transform: { ...(currentTransform(clipId) ?? tf), x: v } }),
          replaceMutation: posAnimated ? posReplace("x") : undefined,
        }),
      ),
    );
    posRow.appendChild(
      field(
        "Y",
        numberInput(clipId, {
          value: posY,
          clamp: (v) => Math.round(v),
          format: (v) => String(Math.round(v)),
          disabled: posAnimated && !inClip,
          disabledHint: hint,
          patch: (v) => ({ transform: { ...(currentTransform(clipId) ?? tf), y: v } }),
          replaceMutation: posAnimated ? posReplace("y") : undefined,
        }),
      ),
    );
    s.appendChild(posRow);

    // Rotate (cycles) — not animatable
    const rotBtn = button(`Rotate ${tf.rotate}°`, "btn btn--sm", () => {
      const cur = currentTransform(clipId) ?? tf;
      const next = ROTATIONS[(ROTATIONS.indexOf(cur.rotate) + 1) % ROTATIONS.length]!;
      commit((p) => updateClip(p, clipId, { transform: { ...cur, rotate: next } }));
    });
    s.appendChild(field("Rotate", rotBtn));

    // Flip switches — not animatable. They mirror the layer along ITS sides,
    // before its rotation (the same convention as the image editor's layer
    // flips), which keeps each switch meaning one thing however the layer is
    // turned — so on a quarter-turned layer "Horizontal" mirrors top to bottom
    // on screen. The labels and the tooltip say so.
    const flipTip =
      "Mirrors this layer along its own sides, before its rotation, so on a layer turned 90° or 270° Horizontal flips it top to bottom on screen.";
    const flipSwitch = (label: string, aria: string, axis: "flipH" | "flipV"): HTMLElement => {
      const sw = switchToggle(tf[axis], (v) => {
        const cur = currentTransform(clipId) ?? tf;
        commit((p) => updateClip(p, clipId, { transform: { ...cur, [axis]: v } }));
      });
      sw.setAttribute("aria-label", aria);
      sw.title = flipTip;
      return field(label, sw);
    };
    const flipRow = el("div", "insp-row");
    flipRow.appendChild(flipSwitch("Horizontal", "Flip layer horizontally", "flipH"));
    flipRow.appendChild(flipSwitch("Vertical", "Flip layer vertically", "flipV"));
    const flipField = field("Flip layer", flipRow);
    flipField.title = flipTip;
    s.appendChild(flipField);

    /* ---- Opacity (animatable) ---- */
    const opacityAnimated = groupAnimated(t.clip.keyframes, "opacity");
    const opacityVal = evalProp(t.clip, "opacity", tf.opacity, src);
    s.appendChild(groupHeader(t, "opacity", "Opacity"));
    s.appendChild(
      slider(clipId, {
        min: 0,
        max: 1,
        step: 0.01,
        value: opacityVal,
        format: (v) => `${Math.round(v * 100)}%`,
        disabled: opacityAnimated && !inClip,
        disabledHint: hint,
        patch: (v) => ({ transform: { ...(currentTransform(clipId) ?? tf), opacity: v } }),
        replaceMutation: opacityAnimated
          ? (v, keySrc) => (p) => setKeyframe(p, clipId, "opacity", keySrc, v)
          : undefined,
      }),
    );

    // Crop
    s.appendChild(buildCrop(t));

    // Auto-fit row: Fit / Fill / Center
    const fitRow = el("div", "insp-row insp-block");
    const fitBtn = button("Fit", "btn btn--sm", () => applyAutoFit(t, "fit"));
    fitBtn.title = "Scale to fit inside the canvas (letterbox) and center";
    const fillBtn = button("Fill", "btn btn--sm", () => applyAutoFit(t, "fill"));
    fillBtn.title = "Scale to cover the canvas (crops edges) and center";
    const centerBtn = button("Center", "btn btn--sm", () => applyAutoFit(t, "center"));
    centerBtn.title = "Center in the canvas (scale unchanged)";
    fitRow.appendChild(fitBtn);
    fitRow.appendChild(fillBtn);
    fitRow.appendChild(centerBtn);
    s.appendChild(fitRow);

    // Reset transform
    s.appendChild(
      button("Reset transform", "btn btn--ghost btn--sm insp-block", () => {
        commit((p) => updateClip(p, clipId, { transform: defaultTransform() }));
      }),
    );

    return s;
  }

  function currentTransform(clipId: string): ClipTransform | undefined {
    const cur = resolve(ctx.session.project, clipId);
    return cur?.clip.transform;
  }

  function buildCrop(t: Target): HTMLElement {
    const clipId = t.clip.id;
    const wrap = el("div", "insp-crop");
    wrap.appendChild(el("div", "insp-sublabel", "Crop"));
    const mediaW = t.media.width ?? 0;
    const mediaH = t.media.height ?? 0;
    const crop = t.clip.transform?.crop ?? { x: 0, y: 0, w: mediaW, h: mediaH };

    const grid = el("div", "insp-crop__grid");
    const mk = (label: string, value: number): HTMLInputElement => {
      const input = el("input", "input insp-num");
      input.type = "number";
      input.value = String(Math.round(value));
      const f = el("div", "field insp-field");
      f.appendChild(el("label", undefined, label));
      f.appendChild(input);
      grid.appendChild(f);
      return input;
    };
    const xI = mk("X", crop.x);
    const yI = mk("Y", crop.y);
    const wI = mk("W", crop.w);
    const hI = mk("H", crop.h);
    wrap.appendChild(grid);

    const btns = el("div", "insp-row");
    btns.appendChild(
      button("Apply", "btn btn--sm", () => {
        const x = Math.round(Number(xI.value) || 0);
        const y = Math.round(Number(yI.value) || 0);
        const w = Math.round(Number(wI.value) || 0);
        const h = Math.round(Number(hI.value) || 0);
        // validate: 0 <= x < x+w <= mediaW ; 0 <= y < y+h <= mediaH
        if (
          !(x >= 0 && w > 0 && x + w <= mediaW && y >= 0 && h > 0 && y + h <= mediaH)
        ) {
          toast.refuse(`Crop must fit inside ${mediaW}×${mediaH}.`);
          return;
        }
        const cur = currentTransform(clipId) ?? defaultTransform();
        commit((p) => updateClip(p, clipId, { transform: { ...cur, crop: { x, y, w, h } } }));
      }),
    );
    btns.appendChild(
      button("Clear", "btn btn--ghost btn--sm", () => {
        const cur = currentTransform(clipId) ?? defaultTransform();
        const { crop: _drop, ...rest } = cur;
        commit((p) => updateClip(p, clipId, { transform: { ...rest } }));
      }),
    );
    wrap.appendChild(btns);
    return wrap;
  }

  function buildAudioSection(t: Target): HTMLElement {
    const s = section("Audio");
    const clipId = t.clip.id;
    const a = t.clip.audio;
    const clipDur = clipDuration(t.clip);

    if (t.onVideoTrack && a.detached) {
      s.appendChild(el("div", "insp-note", "Audio detached"));
      s.appendChild(
        button("Restore audio", "btn btn--sm insp-block", () => {
          commit((p) =>
            updateClip(p, clipId, (c) => ({ ...c, audio: { ...c.audio, detached: false } })),
          );
        }),
      );
      // Warn if a detached copy of this media overlaps our source range on an
      // audio track — restoring would then play the sound twice.
      if (audioCopyOverlaps(ctx.session.project, t)) {
        s.appendChild(
          el(
            "div",
            "insp-note insp-note--warn",
            "A detached copy exists on an audio track — restoring may double the sound.",
          ),
        );
      }
      return s;
    }

    // Volume 0..2 shown as 0..200%
    s.appendChild(
      field(
        "Volume",
        slider(clipId, {
          min: 0,
          max: 2,
          step: 0.01,
          value: a.volume,
          format: (v) => `${Math.round(v * 100)}%`,
          patch: (v) => ({ audio: { ...currentAudio(clipId, a), volume: v } }),
        }),
      ),
    );

    // Mute
    s.appendChild(
      field(
        "Mute",
        switchToggle(a.muted, (v) => {
          commit((p) => updateClip(p, clipId, { audio: { ...currentAudio(clipId, a), muted: v } }));
        }),
      ),
    );

    // Fades
    const fadeRow = el("div", "insp-row");
    fadeRow.appendChild(
      field(
        "Fade in (s)",
        numberInput(clipId, {
          value: a.fadeInSec,
          step: 0.1,
          clamp: (v) => Math.min(Math.max(0, v), clipDur),
          patch: (v) => ({ audio: { ...currentAudio(clipId, a), fadeInSec: v } }),
        }),
      ),
    );
    fadeRow.appendChild(
      field(
        "Fade out (s)",
        numberInput(clipId, {
          value: a.fadeOutSec,
          step: 0.1,
          clamp: (v) => Math.min(Math.max(0, v), clipDur),
          patch: (v) => ({ audio: { ...currentAudio(clipId, a), fadeOutSec: v } }),
        }),
      ),
    );
    s.appendChild(fadeRow);

    // Gain offset readout
    const gainRow = el("div", "insp-readout");
    gainRow.innerHTML = `<span>Gain offset</span><span class="mono">${a.gainOffsetDb >= 0 ? "+" : ""}${a.gainOffsetDb.toFixed(1)} dB</span>`;
    s.appendChild(gainRow);

    // Normalize. The scan outlives this build — the panel rebuilds under it
    // (a trim, an undo, reselecting the clip) — so whether one is running is
    // kept per clip at inspector scope: a rebuilt button keeps saying
    // Analyzing instead of offering a second scan of the same range. Its
    // answer is applied only if the clip still plays the range it measured.
    const running = normalizing.get(clipId);
    const normBtn = button(running ? "Analyzing" : "Normalize", "btn btn--sm insp-block", () => {
      if (normalizing.has(clipId)) return;
      const job = { path: t.media.path, srcIn: t.clip.srcIn, srcOut: t.clip.srcOut, btn: normBtn };
      normalizing.set(clipId, job);
      normBtn.disabled = true;
      normBtn.textContent = "Analyzing";
      ipc
        .normalizeScan(job.path, job.srcIn, job.srcOut)
        .then((r) => {
          // The editor closed while the scan ran: its session and engine are
          // gone, and nobody is looking at this clip any more.
          if (disposed) return;
          const cur = resolve(ctx.session.project, clipId);
          if (
            !cur ||
            cur.media.path !== job.path ||
            cur.clip.srcIn !== job.srcIn ||
            cur.clip.srcOut !== job.srcOut
          ) {
            // Trimmed or relinked meanwhile: the peak was measured on a range
            // this clip no longer plays, so its gain would be a guess. (A
            // deleted clip has nobody to tell.)
            if (cur) toast.info("The clip changed during analysis — run Normalize again.");
            return;
          }
          commit((p) =>
            updateClip(p, clipId, {
              audio: { ...cur.clip.audio, gainOffsetDb: r.suggestedGainDb },
            }),
          );
          toast.info(
            `Peak ${r.maxVolumeDb.toFixed(1)} dB → ${r.suggestedGainDb >= 0 ? "+" : ""}${r.suggestedGainDb.toFixed(1)} dB gain`,
          );
        })
        .catch((e: unknown) => {
          if (disposed) return;
          toast.error(
            `Normalize failed: ${e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e)}`,
          );
        })
        .finally(() => {
          normalizing.delete(clipId);
          if (disposed) return;
          job.btn.disabled = false;
          job.btn.textContent = "Normalize";
        });
    });
    if (running) {
      normBtn.disabled = true;
      running.btn = normBtn;
    }
    s.appendChild(normBtn);

    // Video-track extras: detach / remove
    if (t.onVideoTrack) {
      const row = el("div", "insp-row");
      row.appendChild(
        button("Detach audio", "btn btn--sm", () => {
          const beforeSel = ctx.session.project;
          let newId: string | null = null;
          ctx.session.commit((p) => {
            const r = detachAudio(p, clipId);
            newId = r.audioClipId;
            return r.project;
          });
          if (ctx.session.project !== beforeSel && newId) {
            ctx.selection.set(newId);
          }
          ctx.refresh();
        }),
      );
      row.appendChild(
        button("Remove audio", "btn btn--ghost btn--sm", () => {
          commit((p) => removeClipAudio(p, clipId));
        }),
      );
      s.appendChild(row);
    }

    return s;
  }

  function currentAudio(clipId: string, fallback: Clip["audio"]): Clip["audio"] {
    const cur = resolve(ctx.session.project, clipId);
    return cur?.clip.audio ?? fallback;
  }

  /* -------- project canvas panel (empty-state replacement) -------- */

  function buildProjectPanel(): HTMLElement {
    const wrap = el("div", "insp-project");
    const p = ctx.session.project;
    const w = p.timeline.width;
    const h = p.timeline.height;

    const header = el("div", "insp-header");
    header.appendChild(el("div", "insp-header__name", "Project"));
    wrap.appendChild(header);

    const s = section("Canvas");

    // Preset select (matches a preset → that preset, else Custom).
    const sel = el("select", "select select--sm");
    for (let i = 0; i < CANVAS_PRESETS.length; i++) {
      const preset = CANVAS_PRESETS[i]!;
      const o = el("option");
      o.value = String(i);
      o.textContent = preset.label;
      sel.appendChild(o);
    }
    const customOpt = el("option");
    customOpt.value = "custom";
    customOpt.textContent = "Custom";
    sel.appendChild(customOpt);

    const matchIdx = CANVAS_PRESETS.findIndex((pr) => pr.w === w && pr.h === h);
    sel.value = matchIdx >= 0 ? String(matchIdx) : "custom";

    // W / H inputs — enabled only for Custom; always show current values.
    const wI = el("input", "input insp-num");
    wI.type = "number";
    wI.min = String(MIN_CANVAS);
    wI.max = String(MAX_CANVAS);
    wI.step = "2";
    wI.value = String(w);
    const hI = el("input", "input insp-num");
    hI.type = "number";
    hI.min = String(MIN_CANVAS);
    hI.max = String(MAX_CANVAS);
    hI.step = "2";
    hI.value = String(h);

    const custom = sel.value === "custom";
    wI.disabled = !custom;
    hI.disabled = !custom;

    const applySize = (nw: number, nh: number): void => {
      commit((pr) => setProjectCanvas(pr, nw, nh));
    };

    const onSel = (): void => {
      if (sel.value === "custom") {
        wI.disabled = false;
        hI.disabled = false;
        return;
      }
      const preset = CANVAS_PRESETS[Number(sel.value)]!;
      applySize(preset.w, preset.h);
    };
    sel.addEventListener("change", onSel);
    cleanup.push(() => sel.removeEventListener("change", onSel));
    s.appendChild(field("Size", sel));

    const onCustom = (): void => {
      // An emptied field (or one holding "-" / "1e", which a number input
      // reads as "") is not a size: Number("") is 0 and would commit the
      // minimum canvas. Put back what the project holds instead.
      if (wI.value.trim() === "" || hI.value.trim() === "") {
        wI.value = String(w);
        hI.value = String(h);
        return;
      }
      const nw = Number(wI.value);
      const nh = Number(hI.value);
      if (!Number.isFinite(nw) || !Number.isFinite(nh)) return;
      applySize(nw, nh);
    };
    wI.addEventListener("change", onCustom);
    hI.addEventListener("change", onCustom);
    cleanup.push(() => {
      wI.removeEventListener("change", onCustom);
      hI.removeEventListener("change", onCustom);
    });
    const dimRow = el("div", "insp-row");
    dimRow.appendChild(field("Width", wI));
    dimRow.appendChild(field("Height", hI));
    s.appendChild(dimRow);

    // FPS (read-only)
    const fps = fpsValue(p.timeline.fps);
    const fpsRow = el("div", "insp-readout");
    fpsRow.innerHTML = `<span>Frame rate</span><span class="mono">${Number(fps.toFixed(3))} fps</span>`;
    s.appendChild(fpsRow);

    s.appendChild(
      el(
        "div",
        "insp-note",
        "Clips re-fit automatically. Export uses the canvas size when resolution is Original.",
      ),
    );

    wrap.appendChild(s);
    return wrap;
  }

  /* -------- top-level rebuild -------- */

  function rebuild(): void {
    // Let the field being edited finish FIRST. Every trigger of a rebuild — a
    // timeline or canvas click selecting another clip, a paused ruler seek —
    // lands before focus has moved, and removing a focused element fires no
    // blur and no change: a typed generator text, size or colour, a solid's or
    // the canvas's size was simply thrown away, and a number field's live
    // edits were left in the project with no history entry of their own.
    // blur() runs the field's change and blur handlers synchronously, so they
    // commit with the ids they captured — before clearBuild() detaches them.
    // (The crop fields are staged behind their Apply button by design.)
    const active = document.activeElement;
    if (active instanceof HTMLElement && host.contains(active)) {
      blurring = true;
      try {
        active.blur();
      } finally {
        blurring = false;
      }
    }
    overlayPending = false;
    clearBuild();
    host.innerHTML = "";

    const project = ctx.session.project;
    builtTimeline = project.timeline;
    builtMedia = project.media;
    const sel = ctx.selection.get();
    const t = resolve(project, sel);
    if (!t) {
      host.appendChild(buildProjectPanel());
      return;
    }

    // Header
    const header = el("div", "insp-header");
    header.appendChild(el("div", "insp-header__name", escapeHtml(mediaDisplayName(t.media))));
    const meta = el("div", "insp-header__meta");
    meta.appendChild(el("span", "badge", escapeHtml(t.media.kind)));
    meta.appendChild(el("span", "insp-header__dur mono", formatDuration(clipDuration(t.clip))));
    header.appendChild(meta);
    host.appendChild(header);

    const body = el("div", "insp-body");
    // Generated media (solid / text) get their own editor ABOVE the transform
    // section — transforms still apply to generated clips.
    const genSection = buildGeneratedSection(ctx, t);
    if (genSection) body.appendChild(genSection);

    // Video section only for video-track clips
    if (t.onVideoTrack) body.appendChild(buildVideoSection(t));

    // Audio section for every audio-track clip, and for video-track clips whose
    // media has audio (detached clips render a "detached" note inside it).
    // Generated media have no audio, so this is skipped for them.
    if (!t.media.generator && (!t.onVideoTrack || t.media.hasAudio)) {
      body.appendChild(buildAudioSection(t));
    }
    host.appendChild(body);
  }

  /* -------- reactivity -------- */

  const unsubSel = ctx.selection.subscribe(() => rebuild());
  const unsubSession = ctx.session.store.subscribe((p) => {
    // Rebuild on project changes (e.g. the selected clip was deleted → empty
    // state), but never tear down the DOM mid-drag — ours, or the canvas
    // overlay's, which replace()s the selected clip once per pointermove and
    // would otherwise rebuild the whole panel each time.
    if (dragging) return;
    if (ctx.overlayGestureActive?.()) {
      overlayPending = true;
      return;
    }
    if (p.timeline === builtTimeline && p.media === builtMedia) return;
    rebuild();
  });
  // While PAUSED (scrub/seek/step), rebuild as the playhead moves so a selected
  // clip's diamond state and evaluated readouts track it. During playback we
  // skip this entirely (no per-frame DOM churn) and never rebuild mid-drag.
  // The rebuild is also a no-op when nothing/no-video-clip is selected.
  let lastTickT = -1;
  const unsubTick = ctx.engine.onTick((time, playing) => {
    // `blurring`: a commit run by rebuild()'s blur refreshes the engine, which
    // ticks synchronously — and the rebuild in progress already covers it.
    if (playing || dragging || blurring) return;
    if (time === lastTickT) return;
    lastTickT = time;
    const cur = resolve(ctx.session.project, ctx.selection.get());
    if (!cur || !cur.onVideoTrack || !cur.clip.keyframes) return;
    rebuild();
  });

  rebuild();

  return {
    overlayGestureEnded(): void {
      if (!overlayPending || disposed) return;
      overlayPending = false;
      // As in the store subscriber, a control of our own being held wins. The
      // panel is then behind the drag's result, so forget what it was built
      // from: the next store change after the hold rebuilds, whatever it is.
      if (dragging) {
        invalidateBuilt();
        return;
      }
      rebuild();
    },
    dispose(): void {
      disposed = true;
      unsubSel();
      unsubSession();
      unsubTick();
      clearBuild();
      host.innerHTML = "";
    },
  };
}
