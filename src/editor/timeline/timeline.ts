// Timeline controller: canvas lifecycle (DPR, resize), view state (horizontal
// scroll + zoom, vertical lane scroll), dirty-flag rAF rendering, playhead
// following, and the glue between interactions, the project session, and the
// playback engine.
//
// The panel is a fixed height and the lane stack is not, so the lanes scroll
// vertically inside the host. The offset itself lives in render.ts, folded into
// laneLayout, which is what keeps drawing and hit-testing on one set of
// coordinates — see the note on laneScrollY there before changing any of this.

import type { ProjectSession } from "../../core/session";
import { timelineDuration } from "../../core/time";
import type { Clip, MediaRef, ProjectFile, Track } from "../../core/types";
import type { MediaManager } from "../media/media";
import type { PlaybackEngine } from "../playback/engine";
import { attachInteractions, type DragState } from "./interactions";
import {
  RULER_H,
  clampLaneScroll,
  draw,
  laneScroll,
  maxLaneScroll,
  readColors,
  setLaneScroll,
  totalLanesHeight,
  type TimelineColors,
} from "./render";

export interface TimelineDeps {
  session: ProjectSession;
  media: MediaManager;
  engine: PlaybackEngine;
  select(id: string | null): void;
  getSelected(): string | null;
  snapEnabled(): boolean;
  /** Open the clip context menu at a viewport (client) position. */
  onClipMenu(clip: Clip, clientX: number, clientY: number): void;
  /** Open the lane context menu at a viewport (client) position. */
  onLaneMenu(track: Track, clientX: number, clientY: number): void;
}

const MIN_PX_PER_SEC = 0.5;
const MAX_PX_PER_SEC = 3000;

export class TimelineController {
  readonly canvas: HTMLCanvasElement;
  readonly view = { t0: 0, pxPerSec: 80, width: 0, height: 0 };
  drag: DragState = null;
  guideT: number | null = null;

  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private dirty = false;
  private raf = 0;
  private colors: TimelineColors;
  private mediaById = new Map<string, MediaRef>();
  private mediaByIdOf: ProjectFile | null = null;
  private disposers: (() => void)[] = [];
  private themeObserver: MutationObserver;
  private readonly host: HTMLElement;
  /** Reused overlay guide for external drag-and-drop (created lazily). */
  private dropGuide: HTMLElement | null = null;
  /** Vertical scrollbar chrome, created on first overflow (see syncScrollbar). */
  private scrollBar: HTMLElement | null = null;
  private scrollThumb: HTMLElement | null = null;
  /** Last geometry written to the scrollbar. Compared before every write so a
   *  frame that changes nothing — every frame of playback, since the playhead
   *  moves and the lanes do not — touches the CSSOM zero times. */
  private barShown = false;
  private barTop = -1;
  private barH = -1;

  constructor(
    host: HTMLElement,
    private deps: TimelineDeps,
  ) {
    this.host = host;
    // laneScrollY is module state in render.ts (deliberately — see the note
    // there), so a freshly mounted editor starts at the top rather than
    // inheriting wherever the previous project was scrolled to.
    setLaneScroll(0);
    this.canvas = document.createElement("canvas");
    this.canvas.className = "timeline-canvas";
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
    this.colors = readColors(document.documentElement);

    const resize = (): void => {
      const rect = host.getBoundingClientRect();
      this.dpr = window.devicePixelRatio || 1;
      this.view.width = Math.max(50, rect.width);
      this.view.height = Math.max(50, rect.height);
      this.canvas.width = Math.round(this.view.width * this.dpr);
      this.canvas.height = Math.round(this.view.height * this.dpr);
      this.canvas.style.width = `${this.view.width}px`;
      this.canvas.style.height = `${this.view.height}px`;
      this.requestRender();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();
    this.disposers.push(() => ro.disconnect());

    this.themeObserver = new MutationObserver(() => {
      this.colors = readColors(document.documentElement);
      this.requestRender();
    });
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      // "style" as well as "data-theme": a custom theme writes its derived
      // tokens as inline custom properties on <html>, so editing one never
      // touches data-theme. Without this the canvas keeps the colours it read at
      // mount — and it now takes its background, text and ruler tint from those
      // same variables, so the whole timeline would go stale, not just a clip.
      attributeFilter: ["data-theme", "style"],
    });
    this.disposers.push(() => this.themeObserver.disconnect());

    this.disposers.push(deps.session.store.subscribe(() => this.requestRender()));
    this.disposers.push(deps.media.waveforms.subscribe(() => this.requestRender()));
    this.disposers.push(
      deps.engine.onTick((t, playing) => {
        if (playing) this.follow(t);
        this.requestRender();
      }),
    );
    this.disposers.push(attachInteractions(this));

    // Vertical lane scrolling on ALT + wheel. Deliberately not plain, Shift or
    // Ctrl wheel: those are the existing horizontal pan / fast pan / zoom
    // gestures and stay exactly as they were. Bound on the HOST in the capture
    // phase so it runs before the canvas's own wheel handler, and
    // stopPropagation stops the same notch from also panning sideways. A wheel
    // over the scrollbar itself scrolls without the modifier, as expected of a
    // scrollbar.
    //
    // When there is nothing to scroll the event is left completely alone, so on
    // a project that already fits, ALT + wheel still pans exactly as before.
    const onWheelCapture = (e: WheelEvent): void => {
      const onBar = this.scrollBar !== null && this.scrollBar.contains(e.target as Node);
      if (!onBar && (!e.altKey || e.ctrlKey)) return;
      if (maxLaneScroll(this.project(), this.view.height) <= 0) return;
      e.preventDefault();
      e.stopPropagation();
      this.scrollLanesBy(e.deltaY);
    };
    host.addEventListener("wheel", onWheelCapture, { capture: true, passive: false });
    this.disposers.push(() =>
      host.removeEventListener("wheel", onWheelCapture, { capture: true }),
    );

    this.fit();
  }

  /* ---------------- coordinate helpers ---------------- */

  project(): ProjectFile {
    return this.deps.session.project;
  }
  playhead(): number {
    return this.deps.engine.time;
  }
  xOf(t: number): number {
    return (t - this.view.t0) * this.view.pxPerSec;
  }
  tOf(x: number): number {
    return this.view.t0 + x / this.view.pxPerSec;
  }

  /* ---------------- view ops ---------------- */

  zoomAt(x: number, factor: number): void {
    const anchorT = this.tOf(x);
    const next = Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, this.view.pxPerSec * factor));
    this.view.pxPerSec = next;
    this.view.t0 = Math.max(0, anchorT - x / next);
    this.requestRender();
  }

  zoomCentered(factor: number): void {
    this.zoomAt(this.view.width / 2, factor);
  }

  panBy(px: number): void {
    this.view.t0 = Math.max(0, this.view.t0 + px / this.view.pxPerSec);
    this.requestRender();
  }

  /* ---------------- vertical lane scrolling ----------------
   * The panel is a fixed 280px and "Add video layer" / detachAudio are
   * unbounded, so the lane stack can be arbitrarily taller than the host. The
   * offset lives in render.ts and is baked into laneLayout, which is what keeps
   * drawing and hit-testing on the same coordinates — see the note there. */

  /** Scroll the lane stack by `dy` px (positive scrolls down). */
  scrollLanesBy(dy: number): void {
    this.scrollLanesTo(laneScroll() + dy);
  }

  /** Scroll the lane stack to an absolute offset; clamped to the legal range. */
  scrollLanesTo(px: number): void {
    if (setLaneScroll(clampLaneScroll(this.project(), px, this.view.height))) {
      this.requestRender();
    }
  }

  /** Height of the scrollbar track: the host minus the pinned ruler, which is
   *  also the band the lanes are drawn into and the distance a "page" scrolls. */
  private trackHeight(): number {
    return Math.max(0, this.view.height - RULER_H);
  }

  /** Build the scrollbar on first overflow and wire its drag. Everything here
   *  is owned by the controller: the thumb is a plain absolutely-positioned div
   *  over the canvas, so dragging it never goes near the canvas pointer
   *  handlers. Geometry comes from values we last WROTE, never from
   *  offsetTop/clientHeight, so a scrollbar drag forces no layout. */
  private ensureScrollbar(): HTMLElement {
    if (this.scrollBar) return this.scrollBar;
    const bar = document.createElement("div");
    bar.className = "tl-vscroll";
    bar.style.top = `${RULER_H}px`;
    const thumb = document.createElement("div");
    thumb.className = "tl-vscroll__thumb";
    bar.appendChild(thumb);
    this.host.appendChild(bar);
    this.scrollBar = bar;
    this.scrollThumb = thumb;

    let dragging = false;
    let grabY = 0;
    let grabScroll = 0;

    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const localY = e.clientY - bar.getBoundingClientRect().top;
      if (localY < this.barTop || localY > this.barTop + this.barH) {
        // Track click: page towards the pointer, like a native scrollbar.
        this.scrollLanesBy(localY < this.barTop ? -this.trackHeight() : this.trackHeight());
        return;
      }
      bar.setPointerCapture(e.pointerId);
      dragging = true;
      grabY = e.clientY;
      grabScroll = laneScroll();
      thumb.classList.add("tl-vscroll__thumb--active");
    };
    const onMove = (e: PointerEvent): void => {
      if (!dragging) return;
      // The thumb travels (track - thumb) px while the content travels max px.
      const travel = Math.max(1, this.trackHeight() - this.barH);
      const max = maxLaneScroll(this.project(), this.view.height);
      this.scrollLanesTo(grabScroll + ((e.clientY - grabY) * max) / travel);
    };
    const onUp = (e: PointerEvent): void => {
      if (bar.hasPointerCapture(e.pointerId)) bar.releasePointerCapture(e.pointerId);
      dragging = false;
      thumb.classList.remove("tl-vscroll__thumb--active");
    };

    bar.addEventListener("pointerdown", onDown);
    bar.addEventListener("pointermove", onMove);
    bar.addEventListener("pointerup", onUp);
    bar.addEventListener("pointercancel", onUp);
    return bar;
  }

  /** Reflect the current scroll on the scrollbar, creating it on first need and
   *  hiding it entirely while everything fits (a one-lane project shows no
   *  chrome at all). Called from renderNow with the content height it already
   *  had to compute, so this adds no traversal of the tracks. */
  private syncScrollbar(contentH: number): void {
    const track = this.trackHeight();
    const max = Math.max(0, contentH - this.view.height);
    if (max <= 0 || track <= 0) {
      if (this.barShown) {
        this.scrollBar!.style.display = "none";
        this.barShown = false;
      }
      return;
    }
    const bar = this.ensureScrollbar();
    const h = Math.min(track, Math.max(24, Math.round((track * this.view.height) / contentH)));
    const top = Math.round(((track - h) * laneScroll()) / max);
    if (!this.barShown) {
      bar.style.display = "block";
      this.barShown = true;
    }
    if (h !== this.barH) {
      this.scrollThumb!.style.height = `${h}px`;
      this.barH = h;
    }
    if (top !== this.barTop) {
      this.scrollThumb!.style.top = `${top}px`;
      this.barTop = top;
    }
  }

  /** Fit the whole timeline (plus headroom) into the view. */
  fit(): void {
    const dur = Math.max(1, timelineDuration(this.project().timeline));
    this.view.pxPerSec = Math.min(
      MAX_PX_PER_SEC,
      Math.max(MIN_PX_PER_SEC, (this.view.width * 0.92) / dur),
    );
    this.view.t0 = 0;
    this.requestRender();
  }

  private follow(t: number): void {
    const w = this.view.width / this.view.pxPerSec;
    if (t > this.view.t0 + w * 0.92) {
      this.view.t0 = t - w * 0.08;
    } else if (t < this.view.t0) {
      this.view.t0 = Math.max(0, t - w * 0.08);
    }
  }

  /* ---------------- interaction glue ---------------- */

  select(id: string | null): void {
    this.deps.select(id);
    this.requestRender();
  }
  seek(t: number): void {
    this.deps.engine.seek(t);
    this.requestRender();
  }
  snapEnabled(): boolean {
    return this.deps.snapEnabled();
  }
  commit(mutate: (p: ProjectFile) => ProjectFile): void {
    this.deps.session.commit(mutate);
    this.deps.engine.refresh();
    this.requestRender();
  }
  /** Live, history-free replace during a gesture (drag). */
  liveReplace(mutate: (p: ProjectFile) => ProjectFile): void {
    this.deps.session.replace(mutate(this.deps.session.project));
    this.deps.engine.refresh();
    this.requestRender();
  }
  /** Close a gesture: push one history entry from the captured `before`. */
  commitFrom(before: ProjectFile): void {
    this.deps.session.commitFrom(before);
    this.requestRender();
  }
  /** Delegate to the editor to build a clip context menu. */
  clipMenu(clip: Clip, clientX: number, clientY: number): void {
    this.deps.onClipMenu(clip, clientX, clientY);
  }
  /** Delegate to the editor to build a lane (layer) context menu. */
  laneMenu(track: Track, clientX: number, clientY: number): void {
    this.deps.onLaneMenu(track, clientX, clientY);
  }
  setDrag(drag: DragState, guide: number | null): void {
    this.drag = drag;
    this.guideT = guide;
    this.requestRender();
  }

  /** The timeline host rect in viewport coordinates (for DnD hit-testing). */
  hostRect(): DOMRect {
    return this.host.getBoundingClientRect();
  }

  /** Show a transient drop guide overlaying the host: an accent vertical line
   *  at host-local x plus a lane tint. Pure DOM (no render.ts changes); the one
   *  reusable guide div is created on first use and reused thereafter. */
  setDropPreview(laneY: number, laneH: number, x: number): void {
    if (!this.dropGuide) {
      const g = document.createElement("div");
      g.className = "tl-drop-guide";
      g.innerHTML = `<div class="tl-drop-guide__lane"></div><div class="tl-drop-guide__line"></div>`;
      this.host.appendChild(g);
      this.dropGuide = g;
    }
    const g = this.dropGuide;
    g.style.display = "block";
    const lane = g.firstElementChild as HTMLElement;
    const line = g.lastElementChild as HTMLElement;
    // Clamped to the lane band: a half-scrolled target lane must not tint over
    // the pinned ruler (the canvas clips its own lanes for the same reason).
    const top = Math.max(RULER_H, laneY);
    const bottom = Math.min(this.view.height, laneY + laneH);
    lane.style.top = `${top}px`;
    lane.style.height = `${Math.max(0, bottom - top)}px`;
    line.style.transform = `translateX(${Math.round(x)}px)`;
  }

  clearDropPreview(): void {
    if (this.dropGuide) this.dropGuide.style.display = "none";
  }

  /* ---------------- rendering ---------------- */

  /** Coalesces every render trigger into at most one frame. Schedules on demand
   *  rather than running a permanent rAF pump, so an idle or paused editor does
   *  no per-frame work at all. Every render path in the editor goes through
   *  here, so nothing is missed by not polling. */
  requestRender(): void {
    if (this.dirty) return;
    this.dirty = true;
    this.raf = requestAnimationFrame(this.renderFrame);
  }

  private renderFrame = (): void => {
    this.raf = 0;
    this.dirty = false;
    this.renderNow();
  };

  private renderNow(): void {
    const project = this.project();
    if (this.mediaByIdOf !== project) {
      this.mediaByIdOf = project;
      this.mediaById.clear();
      for (const m of project.media) this.mediaById.set(m.id, m);
    }

    // One traversal of the tracks, reused for the clamp and the scrollbar (this
    // call is not new — the old code already ran totalLanesHeight once a frame,
    // to inflate the draw height past the canvas, which is what made lanes 4+
    // paint into pixels that do not exist).
    //
    // Re-clamping every frame is what keeps the view honest when the lane count
    // shrinks under a scrolled timeline — delete a layer while scrolled to the
    // bottom and the stack slides back up instead of leaving a void.
    const contentH = totalLanesHeight(project);
    const maxScroll = Math.max(0, contentH - this.view.height);
    if (laneScroll() > maxScroll) setLaneScroll(maxScroll);
    this.syncScrollbar(contentH);

    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    draw(this.ctx, {
      project,
      t0: this.view.t0,
      pxPerSec: this.view.pxPerSec,
      width: this.view.width,
      // The canvas is exactly the host's size and the lane stack scrolls inside
      // it. Handing draw a taller height than the canvas was the original bug.
      height: this.view.height,
      playhead: this.playhead(),
      selectedClipId: this.deps.getSelected(),
      drag: this.drag,
      guideT: this.guideT,
      colors: this.colors,
      waveforms: this.deps.media.waveforms.get(),
      mediaById: this.mediaById,
    });
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    for (const d of this.disposers) d();
    this.dropGuide?.remove();
    this.scrollBar?.remove();
    this.canvas.remove();
  }
}
