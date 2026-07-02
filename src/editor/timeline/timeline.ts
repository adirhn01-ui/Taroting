// Timeline controller: canvas lifecycle (DPR, resize), view state (scroll +
// zoom), dirty-flag rAF rendering, playhead following, and the glue between
// interactions, the project session, and the playback engine.

import type { ProjectSession } from "../../core/session";
import { timelineDuration } from "../../core/time";
import type { MediaRef, ProjectFile } from "../../core/types";
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

  constructor(
    host: HTMLElement,
    private deps: TimelineDeps,
  ) {
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
  setDrag(drag: DragState, guide: number | null): void {
    this.drag = drag;
    this.guideT = guide;
    this.requestRender();
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
    this.canvas.remove();
  }
}
