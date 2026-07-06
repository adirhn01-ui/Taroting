// Theater mode: a movie-player-style fullscreen playback view for the preview
// stage. Two stages layer up: (1) an in-window "theater" that lifts the preview
// container over the editor chrome (position:fixed, var(--z-theater)), and (2) a
// BEST-EFFORT true element fullscreen via container.requestFullscreen(). Stage 1
// always works (so tests and no-activation contexts still get the big view);
// stage 2 is opportunistic and, when granted, its OS-level Esc is caught by a
// fullscreenchange listener that tears the whole mode down.
//
// The bottom control bar (play/pause, ±5s, time readout, seek bar, exit) is
// built ONCE and toggled; per-tick work is a handful of style/text writes gated
// so they fire only when the displayed value actually changed (frame-quantized).
// Nothing here costs anything while theater is off — the tick subscription is a
// no-op early-return and the bar is display:none.

import { formatTimecode } from "../../core/format";
import { icon } from "../../ui/icons";
import type { MonitorVolumeState } from "../playback/audio-graph";
import type { PlaybackEngine } from "../playback/engine";

/** The shared monitor-volume controller (owned by editor.ts). Both the
 *  transport flyout and this bar drive the same level; subscribing keeps the
 *  glyph + slider in sync when the other UI changes it. */
export interface MonitorVolumeController {
  get(): MonitorVolumeState;
  setLevel(v: number): void;
  toggleMute(): void;
  subscribe(fn: (s: MonitorVolumeState) => void): () => void;
}

export interface TheaterCtx {
  engine: PlaybackEngine;
  /** the .editor__preview container that gets lifted fullscreen */
  container: HTMLElement;
  /** shared monitor-volume control mirrored in the bar's speaker + slider */
  volume: MonitorVolumeController;
  /** reflect open/close on the transport fullscreen button (title + glyph) */
  onChange?(active: boolean): void;
  /** refit the stage's letterbox to the container's CURRENT box. Called on every
   *  size-changing transition (enter/exit theater, gain/lose element fullscreen)
   *  so the video scales crisply with clean black bars instead of keeping a stale
   *  windowed size. The stage's ResizeObserver also fires, but the container jump
   *  to fixed inset-0 can race the observer, so we call this explicitly too. */
  refit?(): void;
}

/** How far a ±5s skip jumps, in seconds. */
const SKIP = 5;
/** Idle time before the bar + cursor fade out during playback (ms). */
const AUTO_HIDE_MS = 2500;

export interface Theater {
  toggle(): void;
  enter(): void;
  exit(): void;
  isActive(): boolean;
  dispose(): void;
}

export function mountTheater(ctx: TheaterCtx): Theater {
  const { engine, container, volume } = ctx;

  let active = false;

  /* ---------------- control bar (built once) ---------------- */

  const bar = document.createElement("div");
  bar.className = "theater-bar";
  bar.innerHTML = `
    <button class="btn btn--ghost btn--icon theater-bar__btn" data-act="playpause" title="Play / Pause (Space)">${icon("play")}</button>
    <button class="btn btn--ghost btn--icon theater-bar__btn" data-act="back5" title="Back 5s (←)">${icon("skipBack5")}</button>
    <button class="btn btn--ghost btn--icon theater-bar__btn" data-act="fwd5" title="Forward 5s (→)">${icon("skipFwd5")}</button>
    <div class="theater-bar__time mono" data-el="time">00:00 / 00:00</div>
    <div class="theater-bar__seek" data-el="seek" role="slider" aria-label="Seek" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" tabindex="-1">
      <div class="theater-bar__seek-fill" data-el="fill"></div>
      <div class="theater-bar__seek-knob" data-el="knob"></div>
    </div>
    <div class="theater-bar__volume">
      <button class="btn btn--ghost btn--icon theater-bar__btn" data-act="mute" title="Mute / unmute">${icon("volume")}</button>
      <input class="slider theater-bar__volume-slider" data-el="volume" type="range" min="0" max="1" step="0.01" aria-label="Monitor volume" tabindex="-1" />
    </div>
    <button class="btn btn--ghost btn--icon theater-bar__btn" data-act="exit" title="Exit fullscreen (F / Esc)">${icon("fullscreenExit")}</button>
  `;

  const $ = <T extends HTMLElement>(sel: string): T => bar.querySelector<T>(sel)!;
  const playBtn = $<HTMLButtonElement>('[data-act="playpause"]');
  const timeEl = $('[data-el="time"]');
  const seekEl = $('[data-el="seek"]');
  const fillEl = $('[data-el="fill"]');
  const knobEl = $('[data-el="knob"]');
  const muteBtn = $<HTMLButtonElement>('[data-act="mute"]');
  const volSlider = $<HTMLInputElement>('[data-el="volume"]');

  container.appendChild(bar);

  /* ---------------- idempotent glyph + readout ---------------- */

  // Copy the transport's idiom: swap the play/pause SVG only on an actual flip,
  // never per tick, so a mouse-down that landed on the glyph still pairs with its
  // mouse-up (the <svg> is pointer-events:none via .theater-bar CSS as well).
  let playBtnShows: "play" | "pause" | null = null;
  const updatePlayBtn = (): void => {
    const want = engine.playing ? "pause" : "play";
    if (playBtnShows === want) return;
    playBtnShows = want;
    playBtn.innerHTML = icon(want);
  };

  /* ---------------- monitor volume (speaker + slider) ---------------- */

  // Mirrors the transport control (same shared controller). Swap the speaker
  // glyph only on the muted↔audible flip — same idempotent pattern as the play
  // button — and never write the slider the user is actively dragging.
  let muteShows: boolean | null = null;
  const reflectVolume = (s: MonitorVolumeState): void => {
    const muted = s.level <= 0;
    if (muteShows !== muted) {
      muteShows = muted;
      muteBtn.innerHTML = icon(muted ? "mute" : "volume");
    }
    if (document.activeElement !== volSlider) volSlider.value = String(s.level);
  };
  reflectVolume(volume.get());
  const unVolume = volume.subscribe(reflectVolume);

  // Time readout + seek geometry are a pure function of (time, duration) at frame
  // resolution. Cache the last rendered strings/positions so steady-state ticks
  // write zero DOM once the displayed frame stops changing.
  let lastTimeText = "";
  let lastPct = -1;
  const updateReadout = (): void => {
    const fps = engine.fps();
    const dur = engine.duration();
    const text = `${formatTimecode(engine.time, fps)} / ${formatTimecode(dur, fps)}`;
    if (text !== lastTimeText) {
      lastTimeText = text;
      timeEl.textContent = text;
    }
    // quantize the bar position to 0.1% so tiny sub-pixel deltas don't thrash
    const pct = dur > 0 ? Math.round((engine.time / dur) * 1000) / 10 : 0;
    if (pct !== lastPct) {
      lastPct = pct;
      fillEl.style.width = `${pct}%`;
      knobEl.style.left = `${pct}%`;
      seekEl.setAttribute("aria-valuenow", String(pct));
    }
  };

  // Ride the engine tick — but only do work while theater is open. Zero cost off.
  // The tick never REVEALS the bar (that would defeat auto-hide); it only keeps
  // the glyph/readout live and, on a play↔pause flip, (dis)arms the hide timer.
  let wasPlaying = false;
  const unTick = engine.onTick(() => {
    if (!active) return;
    updatePlayBtn();
    updateReadout();
    if (engine.playing !== wasPlaying) {
      wasPlaying = engine.playing;
      // starting playback arms the countdown from the current (revealed) state;
      // pausing reveals immediately and cancels any pending hide.
      if (engine.playing) armHideTimer();
      else reveal();
    }
  });

  /* ---------------- auto-hide ---------------- */

  // ONE timer. `reveal()` shows the chrome + restarts the countdown on real user
  // activity; `armHideTimer()` (re)starts the countdown WITHOUT touching current
  // visibility. Hides only after AUTO_HIDE_MS of no activity WHILE PLAYING; never
  // hides while paused or scrubbing.
  let hideTimer: number | undefined;
  let hidden = false;
  let scrubbing = false;

  const setHidden = (v: boolean): void => {
    if (v === hidden) return;
    hidden = v;
    container.classList.toggle("theater--hidden", v);
  };

  function armHideTimer(): void {
    window.clearTimeout(hideTimer);
    if (!active || !engine.playing || scrubbing) return;
    hideTimer = window.setTimeout(() => {
      if (active && engine.playing && !scrubbing) setHidden(true);
    }, AUTO_HIDE_MS);
  }

  /** User activity: reveal instantly and restart the idle countdown. */
  function reveal(): void {
    if (!active) return;
    setHidden(false);
    armHideTimer();
  }

  /* ---------------- transport actions ---------------- */

  const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
  const skip = (delta: number): void => {
    engine.seek(clamp(engine.time + delta, 0, engine.duration()));
  };

  // Every bar button blurs after activation: a focused <button> makes Space a
  // native activation ON TOP OF the window shortcut → a double toggle, and would
  // let a following ArrowLeft/Right land on the button. Blur so Space and the
  // arrows are owned solely by the (intercepting) keyboard handlers.
  playBtn.addEventListener("click", () => {
    engine.toggle();
    playBtn.blur();
    reveal();
  });
  $<HTMLButtonElement>('[data-act="back5"]').addEventListener("click", (e) => {
    skip(-SKIP);
    (e.currentTarget as HTMLButtonElement).blur();
    reveal();
  });
  $<HTMLButtonElement>('[data-act="fwd5"]').addEventListener("click", (e) => {
    skip(SKIP);
    (e.currentTarget as HTMLButtonElement).blur();
    reveal();
  });
  $<HTMLButtonElement>('[data-act="exit"]').addEventListener("click", () => exit());

  // Volume: the speaker toggles mute, the slider sets the level. A drag reuses
  // the seek bar's `scrubbing` latch so the bar can't auto-hide (and go
  // pointer-events:none, killing the drag) even if the thumb is held still. The
  // <input> is a sibling of the seek bar; we stop its pointerdown so the drag
  // can never fall through to the seek/scrub handlers.
  muteBtn.addEventListener("click", () => {
    volume.toggleMute();
    muteBtn.blur();
    reveal();
  });
  volSlider.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    scrubbing = true;
    reveal();
  });
  const endVolDrag = (): void => {
    if (!scrubbing) return;
    scrubbing = false;
    reveal();
  };
  volSlider.addEventListener("pointerup", endVolDrag);
  volSlider.addEventListener("pointercancel", endVolDrag);
  volSlider.addEventListener("input", () => {
    volume.setLevel(Number(volSlider.value));
    reveal();
  });

  /* ---------------- seek bar (click + drag) ---------------- */

  // Mirrors the timeline ruler's scrub: seek on down + every move, and do NOT
  // pause playback (timeline.seek → engine.seek only). Pointer capture keeps the
  // drag alive outside the thin bar.
  const seekTo = (clientX: number): void => {
    const box = seekEl.getBoundingClientRect();
    if (box.width <= 0) return;
    const frac = clamp((clientX - box.left) / box.width, 0, 1);
    engine.seek(frac * engine.duration());
  };
  seekEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    scrubbing = true;
    try {
      seekEl.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer (autotest) — listeners still fire on the element */
    }
    seekTo(e.clientX);
    reveal();
  });
  seekEl.addEventListener("pointermove", (e) => {
    if (!scrubbing) return;
    seekTo(e.clientX);
  });
  const endScrub = (e: PointerEvent): void => {
    if (!scrubbing) return;
    scrubbing = false;
    try {
      seekEl.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    reveal();
  };
  seekEl.addEventListener("pointerup", endScrub);
  seekEl.addEventListener("pointercancel", endScrub);

  /* ---------------- keyboard (while active) ---------------- */

  // Capture-phase so ArrowLeft/ArrowRight become ±5s INSTEAD of the global
  // frame-step, and F/Esc exit — mirrors the overlay's stopPropagation approach.
  // Space is deliberately NOT intercepted: it bubbles to the window shortcut so
  // play/pause keeps working exactly as elsewhere.
  const onKeyDown = (e: KeyboardEvent): void => {
    if (!active) return;
    // typing targets never reach us in this mode, but stay safe if one is focused
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    reveal();
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      skip(-SKIP);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      skip(SKIP);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      exit();
    }
    // F is handled by the global "fullscreen" shortcut (toggle), so it exits too;
    // leaving it un-intercepted keeps a single rebindable source of truth.
  };
  const onPointerMove = (): void => reveal();

  /* ---------------- stage refit ---------------- */

  // Refit the letterbox to the container's CURRENT box after a size-changing
  // transition. Two frames: rAF lets the class toggle / fullscreen flip apply
  // layout first, so getBoundingClientRect() inside fit() reads the new size
  // rather than the stale windowed one. Cancel any pending refit so rapid
  // enter→exit doesn't fire a refit against an intermediate size.
  let refitRaf: number | undefined;
  function scheduleRefit(): void {
    if (!ctx.refit) return;
    window.cancelAnimationFrame(refitRaf ?? 0);
    refitRaf = window.requestAnimationFrame(() => {
      refitRaf = window.requestAnimationFrame(() => ctx.refit?.());
    });
  }

  /* ---------------- fullscreen sync ---------------- */

  // OS-level Esc exits element fullscreen but not our in-window layer; catch the
  // resulting fullscreenchange (document.fullscreenElement cleared) and finish
  // the teardown so the two stages never desync. Either direction (gain OR lose
  // element fullscreen) resizes the container, so refit on every change.
  const onFsChange = (): void => {
    if (active && !document.fullscreenElement) exit();
    else scheduleRefit();
  };

  /* ---------------- enter / exit ---------------- */

  /** If the canvas overlay is in crop mode, exit crop first (theater is a viewing
   *  mode). Detected via the crop window's rendered display so overlay.ts stays
   *  untouched; an Escape keydown on the overlay runs its exitCrop(). */
  function exitCropIfActive(): void {
    const win = container.querySelector<HTMLElement>(".stage-overlay__window");
    if (win && getComputedStyle(win).display !== "none") {
      const overlay = container.querySelector<HTMLElement>(".stage-overlay");
      overlay?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }
  }

  function enter(): void {
    if (active) return;
    exitCropIfActive();
    active = true;
    container.classList.add("theater");
    // force a fresh glyph/readout paint on open regardless of cached state
    playBtnShows = null;
    lastTimeText = "";
    lastPct = -1;
    updatePlayBtn();
    updateReadout();

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("fullscreenchange", onFsChange);
    container.addEventListener("pointermove", onPointerMove);

    // best-effort true fullscreen; rejects without a user gesture (tests) — the
    // in-window theater is already up, so we simply ignore the rejection.
    const rf = container.requestFullscreen?.();
    if (rf) rf.catch(() => {});

    // the container jumped to fixed inset-0: refit the letterbox to the new box
    // so the video scales crisply (no stale windowed size / transient stretch).
    scheduleRefit();

    reveal();
    ctx.onChange?.(true);
  }

  function exit(): void {
    if (!active) return;
    active = false;
    scrubbing = false;
    window.clearTimeout(hideTimer);
    setHidden(false);
    container.classList.remove("theater");

    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("fullscreenchange", onFsChange);
    container.removeEventListener("pointermove", onPointerMove);

    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});

    // the container returned to its windowed flow box: refit back down so the
    // stage doesn't keep the fullscreen-sized letterbox.
    scheduleRefit();

    ctx.onChange?.(false);
  }

  function toggle(): void {
    if (active) exit();
    else enter();
  }

  return {
    toggle,
    enter,
    exit,
    isActive: () => active,
    dispose(): void {
      exit();
      unTick();
      unVolume();
      window.clearTimeout(hideTimer);
      window.cancelAnimationFrame(refitRaf ?? 0);
      bar.remove();
    },
  };
}
