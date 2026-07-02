// Timeline controller: canvas lifecycle (DPR, resize), view state (scroll +
// zoom), dirty-flag rAF rendering, playhead following, and the glue between
// interactions, the project session, and the playback engine.

import type { ProjectSession } from "../../core/session";
import { timelineDuration } from "../../core/time";
import type { Clip, MediaRef, ProjectFile } from "../../core/types";
import type { MediaManager } from "../media/media";
import type { PlaybackEngine } from "../playback/engine";
import { attachInteractions, type DragState } from "./interactions";
import { draw, readColors, totalLanesHeight, type TimelineColors } from "./render";

export interface TimelineDeps {
  session: ProjectSession;
  media: MediaManager;
  engine: PlaybackEngine;
  select(id: string | null): void;
  getSelected(): string | null;
  snapEnabled(): boolean;
  /** Open the clip context menu at a viewport (client) position. */
  onClipMenu(clip: Clip, clientX: number, clientY: number): void;
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
  private dirty = true;
  private raf = 0;
  private colors: TimelineColors;
  private mediaById = new Map<string, MediaRef>();
  private mediaByIdOf: ProjectFile | null = null;
  private disposers: (() => void)[] = [];
  private themeObserver: MutationObserver;
  private readonly host: HTMLElement;
  /** Reused overlay guide for external drag-and-drop (created lazily). */
  private dropGuide: HTMLElement | null = null;

  constructor(
    host: HTMLElement,
    private deps: TimelineDeps,
  ) {
    this.host = host;
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
      attributeFilter: ["data-theme"],
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

    this.fit();
    this.startLoop();
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
  /** Current project snapshot (for capturing a gesture's `before`). */
  projectSnapshot(): ProjectFile {
    return this.deps.session.project;
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
    lane.style.top = `${laneY}px`;
    lane.style.height = `${laneH}px`;
    line.style.transform = `translateX(${Math.round(x)}px)`;
  }

  clearDropPreview(): void {
    if (this.dropGuide) this.dropGuide.style.display = "none";
  }

  /* ---------------- rendering ---------------- */

  requestRender(): void {
    this.dirty = true;
  }

  private startLoop(): void {
    const loop = (): void => {
      if (this.dirty) {
        this.dirty = false;
        this.renderNow();
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private renderNow(): void {
    const project = this.project();
    if (this.mediaByIdOf !== project) {
      this.mediaByIdOf = project;
      this.mediaById.clear();
      for (const m of project.media) this.mediaById.set(m.id, m);
    }
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    draw(this.ctx, {
      project,
      t0: this.view.t0,
      pxPerSec: this.view.pxPerSec,
      width: this.view.width,
      height: Math.max(this.view.height, totalLanesHeight(project)),
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
    this.canvas.remove();
  }
}
